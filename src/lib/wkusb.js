// WKUSB / WKMini / WKUSB-AF integration over Web Serial.
//
// Boundary between the chat UI and the K1EL WinKeyer 3 hardware. The protocol
// transcript I followed is in this repo's `data.txt`.
//
// Web Serial requirements:
//   - Chrome or Edge (no Firefox / Safari support)
//   - HTTPS or http://localhost
//   - A user gesture to call navigator.serial.requestPort()
//
// Init flow (device-as-source-of-truth, per user spec 2026-04-08):
//   1. Open serial port
//   2. Send Set WK3 Mode (00 14)             ← admin, pre-host-open
//   3. Send Dump EEPROM (00 0C), capture 256 ← admin, pre-host-open
//   4. Parse first 15 bytes (Load Defaults order, see parseLoadDefaults)
//   5. Hydrate `settings` from the parsed values + cached sidetone volume
//   6. Send Host Open (00 02), discard revision-code byte
//   7. If Mode register bit 6 (paddle echo) was 0 OR bit 2 (serial echo)
//      was 1 → log the offending byte and write a corrected Set Mode
//   8. If PinCfg bit 0 (PTT) was 1 → log it and write a corrected Set PinCfg
//
// The dump-then-correct approach replaced an earlier "always push hardcoded
// init bytes" policy. The hardcoded version trampled the user's standalone
// EEPROM state on every connect; this version touches the device only when
// it disagrees with the routing-critical bits.
//
// Routing model (only paddle echoback is enabled, serial echoback is OFF):
//   - sendText(): writes ASCII bytes the device plays as Morse via sidetone
//     and the configured KEY output. The device does NOT echo these back.
//   - Any echo byte we receive is therefore from the operator's paddles, and
//     gets dispatched via onChar() into the chat layer.
//
// All numeric constants are documented inline; if you change them, double-
// check against `data.txt` (Mode register, X1/X2 mode, PinCfg).

// ─── Protocol constants ────────────────────────────────────────────────────

// Admin commands (always prefixed with 0x00).
const ADMIN_HOST_OPEN     = new Uint8Array([0x00, 0x02]);
const ADMIN_HOST_CLOSE    = new Uint8Array([0x00, 0x03]);
const ADMIN_DUMP_EEPROM   = new Uint8Array([0x00, 0x0C]); // admin 12
const ADMIN_SET_WK3_MODE  = new Uint8Array([0x00, 0x14]); // admin 20

// Dump EEPROM returns all 256 bytes back-to-back, raw (NOT wire-tagged), so
// the read loop has to be put into a "capture next N bytes verbatim" mode for
// the duration of the transfer. At 1200 baud, 256 bytes ≈ 2.13 s wall-clock,
// so a 3 s timeout gives plenty of headroom.
const EEPROM_DUMP_BYTES   = 256;
const EEPROM_DUMP_TIMEOUT_MS = 3000;

// ─── Mode register layout (Set WinKeyer Mode, command 0x0E) ───────────────
//
// Bit 7: DISABLE paddle watchdog (1 = disabled, 0 = enabled).
// Bit 6: Paddle echoback enable. **LOAD-BEARING** — must stay 1 or paddle
//        input never reaches us, breaking the chat→pair routing.
// Bits 5,4: Key mode (00 Iambic B, 01 Iambic A, 10 Ultimatic, 11 Bug).
// Bit 3: Paddle swap.
// Bit 2: Serial echoback. **LOAD-BEARING** — must stay 0 or our own writes
//        get echoed back to us as fake paddle input.
// Bit 1: Autospace.
// Bit 0: Contest spacing.
//
// computeModeRegister() forces bits 6 and 2 and OR's the rest from settings.
// If you change this, double-check the routing model still holds.
const MODE_PADDLE_ECHO_ON  = 0x40;
const MODE_SERIAL_ECHO_ON  = 0x04;

// Key mode bit values for mode register bits 5,4. The wire mapping is:
//   00 = Iambic B (0x00),  01 = Iambic A (0x10),
//   10 = Ultimatic (0x20), 11 = Bug      (0x30)
const KEY_MODE_BITS = {
  iambicB:   0x00,
  iambicA:   0x10,
  ultimatic: 0x20,
  bug:       0x30,
};

// Inverse lookup used when parsing the EEPROM mode-register byte back into
// the settings string ('iambicA' / 'iambicB' / 'ultimatic' / 'bug').
const KEY_MODE_BY_BITS = Object.fromEntries(
  Object.entries(KEY_MODE_BITS).map(([k, v]) => [v, k])
);

// ─── PinCfg layout (Set PinConfig, command 0x09) ──────────────────────────
//
// Bits 7,6: Ultimatic priority (00 normal, 01 dah, 10 dit, 11 undef).
// Bits 5,4: Paddle hang time (0..3 → 1ws + {1,2,4,8} dits).
// Bit 3: KeyOut 1 enable.
// Bit 2: KeyOut 2 enable.
// Bit 1: Sidetone enable.
// Bit 0: PTT enable.
//
// computePinConfig() builds the entire byte from settings. Bit 0 (PTT) is
// load-bearing OFF: this app doesn't drive a transmitter, and a stuck PTT
// would key whatever's on the other end of the radio cable. The connect()
// init flow checks the dumped EEPROM byte and rewrites it if PTT is set.
const PIN_CFG_PTT_ON = 0x01;

const ULTIMATIC_BITS = {
  normal: 0x00,
  dah:    0x40,
  dit:    0x80,
};

// Inverse lookup used when parsing the EEPROM PinCfg byte back into the
// settings string ('normal' / 'dah' / 'dit').
const ULTIMATIC_BY_BITS = Object.fromEntries(
  Object.entries(ULTIMATIC_BITS).map(([k, v]) => [v, k])
);

// Set Sidetone Volume — admin command 25 (decimal). The K1EL convention is
// that the manual's decimal label number IS the hex command byte (so "20:
// Set WK3 Mode" → 0x14 because 20 dec = 0x14 hex). The manual entry for
// this command reads `25: Set Sidetone Volume <00><24><n>`, but the `<24>`
// is a TYPO — the author wrote the decimal command number where the hex
// byte should be. The actual wire byte is `0x19` (= 25 decimal), confirmed
// 2026-04-08 by cross-referencing every other command in our code against
// the same convention. Sending `0x24` (the typo'd byte) errored the device
// twice in earlier tests; that's command Get LMOD or thereabouts on K1EL,
// not the volume command.
//
// `n` = 0x01 (low) … 0x04 (high). The intermediate values 0x02 and 0x03
// are valid steps, so the UI exposes the full 1..4 range.
const VALID_SIDETONE_VOLUMES = new Set([1, 2, 3, 4]);





// WPM range allowed by Set WPM Speed (0x02 nn).
const MIN_WPM = 5;
const MAX_WPM = 99;

// Sidetone frequency range exposed by the UI — full WK3 continuous range
// per the WinKeyer 3 datasheet (500–4000 Hz). The byte value is
// 62500/freq_hz; in WK3 all 8 bits are used (the WK1/WK2 paddle-only
// sidetone bit is relocated to the X2MODE register so the MSB is now part
// of the frequency).
const MIN_SIDETONE_HZ = 500;
const MAX_SIDETONE_HZ = 4000;

// localStorage keys.
//
// Most settings are NOT cached on the host any more — connect() reads them
// fresh from the device's EEPROM, which is the source of truth. The lone
// exception is sidetone volume: it's not in the Load Defaults map and we
// don't (yet) know its EEPROM address, so it's still cached host-side.
const SIDETONE_VOLUME_KEY = 'morseChat.wkusbSidetoneVolume';
const LEGACY_SETTINGS_KEY = 'morseChat.wkusbSettings';

// Default settings — used as the disconnected-display fallback before any
// device has been seen this session. Once connect() runs, every field
// (except sidetoneVolume) is overwritten with values parsed from EEPROM.
function defaultSettings() {
  return {
    // Speed
    wpm: 20,
    maxWpm: 35,

    // Sidetone freq (Sidetone Control 0x01 nn)
    sidetoneHz: 553, // ~ 0x71

    // Sidetone volume level 1..4 (Set Sidetone Volume 00 19 nn). Defaults
    // to 1 because the device's actual volume is unknown until the user
    // changes it — and changing it is what writes the value to the device,
    // so a sane low default avoids surprising loud sidetone on first use.
    sidetoneVolume: 1,

    // ── Mode register fields (computed into Set Mode 0E nn) ──
    keyMode: 'iambicA',     // bits 5,4 → 0x10
    paddleSwap: false,      // bit 3
    autospace: false,       // bit 1
    contestSpacing: false,  // bit 0
    paddleWatchdog: true,   // bit 7 (true = watchdog ENABLED, bit cleared)

    // ── PinCfg fields (computed into Set PinCfg 09 nn) ──
    ultimaticPriority: 'normal', // bits 7,6
    hangTime: 0,                  // bits 5,4 (0..3)
    keyOut1Enabled: false,        // bit 3
    keyOut2Enabled: false,        // bit 2
    sidetoneEnabled: true,        // bit 1
    // bit 0 (PTT) is always 0 — no UI control, no setter.
  };
}

function loadSidetoneVolume() {
  try {
    if (typeof window === 'undefined') return 1;
    const raw = window.localStorage.getItem(SIDETONE_VOLUME_KEY);
    if (!raw) return 1;
    const n = parseInt(raw, 10);
    return VALID_SIDETONE_VOLUMES.has(n) ? n : 1;
  } catch (_err) {
    return 1;
  }
}

function saveSidetoneVolume(level) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SIDETONE_VOLUME_KEY, String(level));
  } catch (_err) {
    /* no-op */
  }
}

// One-time migration: drop the old monolithic settings blob so we don't
// leave stale per-field state behind. Runs at module load.
function migrateLegacySettings() {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(LEGACY_SETTINGS_KEY);
  } catch (_err) {
    /* no-op */
  }
}

function hzToSidetoneByte(hz) {
  // Per datasheet: byte = 62500 / freq_hz, clamped into the 8-bit range.
  const byte = Math.round(62500 / hz);
  return Math.max(1, Math.min(255, byte));
}

function clampWpm(wpm) {
  // Clamp to the protocol bounds AND the user's configured maxWpm.
  const upper = Math.min(MAX_WPM, settings ? settings.maxWpm : MAX_WPM);
  return Math.max(MIN_WPM, Math.min(upper, Math.round(wpm)));
}

function clampMaxWpm(wpm) {
  // The max-WPM control itself only needs to be a sane WPM value; floor it
  // a little above MIN_WPM so the slider always has a usable range.
  return Math.max(MIN_WPM + 5, Math.min(MAX_WPM, Math.round(wpm)));
}

function clampHz(hz) {
  return Math.max(MIN_SIDETONE_HZ, Math.min(MAX_SIDETONE_HZ, Math.round(hz)));
}

// Live, mutable settings. Hydrated from EEPROM on connect; before that, the
// disconnected display falls back to defaultSettings(). sidetoneVolume is
// the one field that persists across sessions via localStorage (see comment
// on SIDETONE_VOLUME_KEY).
migrateLegacySettings();
const settings = defaultSettings();
settings.sidetoneVolume = loadSidetoneVolume();

// Status byte bit masks (status byte tag is the top two bits 0b11xxxxxx).
const STATUS_BUSY    = 0x04;
const STATUS_BREAKIN = 0x02;
const STATUS_XOFF    = 0x01;

// ─── Module state ──────────────────────────────────────────────────────────

const charListeners = new Set();
const stateListeners = new Set();
const settingsListeners = new Set();

let port = null;
let reader = null;
let writer = null;
let readLoopPromise = null;

let connected = false;
let busy = false;
let expectingRevision = false;

// Read-loop mode toggle. In NORMAL mode the loop classifies each byte by
// its WK3 wire tag (status / speed-pot / echo). In EEPROM_CAPTURE mode it
// dumps every incoming byte verbatim into dumpBuffer until dumpExpected
// bytes have been collected (or the timeout fires), then resolves
// dumpResolve and flips back to NORMAL.
let readMode = 'NORMAL';
let dumpBuffer = null;
let dumpReceived = 0;
let dumpExpected = 0;
let dumpResolve = null;
let dumpTimeoutId = null;

// ─── Public API ────────────────────────────────────────────────────────────

export function isWebSerialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export function isConnected() {
  return connected;
}

export function isBusy() {
  return busy;
}

// Subscribe to characters arriving FROM the WKUSB (paddle input). Returns an
// unsubscribe function.
export function onChar(cb) {
  charListeners.add(cb);
  return () => charListeners.delete(cb);
}

// Subscribe to high-level state changes ('connected' | 'disconnected'
// | 'busy' | 'idle' | 'error'). Returns an unsubscribe function.
export function onState(cb) {
  stateListeners.add(cb);
  return () => stateListeners.delete(cb);
}

// Open a serial port to the WKUSB. MUST be called from a user gesture
// (e.g. a button click) because of Web Serial security rules. Returns true
// on successful host-mode entry.
//
// Init flow (see top-of-file comment for the full rationale):
//   open → Set WK3 Mode → Dump EEPROM → parse → Host Open → corrections.
export async function connect() {
  if (!isWebSerialSupported()) {
    throw new Error('Web Serial is not available — use Chrome or Edge over HTTPS or localhost.');
  }
  if (connected) return true;

  port = await navigator.serial.requestPort();
  await port.open({
    baudRate: 1200,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    flowControl: 'none',
  });

  writer = port.writable.getWriter();
  reader = port.readable.getReader();

  // Start the read loop before sending anything. It begins in NORMAL mode;
  // armEepromCapture() flips it to EEPROM_CAPTURE for the duration of the
  // dump and back again on completion.
  readLoopPromise = runReadLoop();

  try {
    // Step 1: Set WK3 mode. Admin command, accepted in standalone mode
    // (i.e. before Host Open). No response from the device.
    await writer.write(ADMIN_SET_WK3_MODE);
    await sleep(50); // small settle so the device is ready for the next command

    // Step 2: Dump EEPROM. Arm the capture FIRST, then send the command —
    // otherwise we'd race the first incoming byte against the mode flip.
    const dumpPromise = armEepromCapture(EEPROM_DUMP_BYTES, EEPROM_DUMP_TIMEOUT_MS);
    await writer.write(ADMIN_DUMP_EEPROM);
    const eepromBytes = await dumpPromise; // throws on timeout

    // Step 3: Parse the first 15 bytes (Load Defaults order) into a
    // settings snapshot plus the raw mode/pincfg bytes for the correction
    // checks.
    const { raw, parsed } = parseLoadDefaults(eepromBytes);

    // Step 4: Hydrate `settings` from EEPROM. sidetoneVolume is preserved
    // from the localStorage cache because it's not in the Load Defaults map.
    Object.assign(settings, parsed);

    // Step 5: Host Open. The device responds with a single revision-code
    // byte, which the read loop discards via expectingRevision.
    expectingRevision = true;
    await writer.write(ADMIN_HOST_OPEN);
    await sleep(150);

    // Step 6: Conditional Mode register correction. Bit 6 (paddle echoback)
    // MUST be 1 and bit 2 (serial echoback) MUST be 0 for the chat→pair
    // routing model to hold. If the device disagrees, log the original byte
    // and write back a corrected version that preserves every other field.
    if (needsModeCorrection(raw.modeReg)) {
      const corrected = correctModeRegister(raw.modeReg);
      console.warn(
        `[wkusb] Mode register correction: device byte 0x${hex(raw.modeReg)} → 0x${hex(corrected)} ` +
        `(forcing paddle echoback ON, serial echoback OFF)`
      );
      await writer.write(new Uint8Array([0x0E, corrected]));
    }

    // Step 7: Conditional PinCfg correction. Bit 0 (PTT enable) MUST be 0
    // — the app doesn't drive a transmitter and a stuck PTT would key any
    // attached radio. Same pattern: log the original byte, write a
    // corrected version with only that bit cleared.
    if (needsPinCfgCorrection(raw.pinCfg)) {
      const corrected = correctPinCfg(raw.pinCfg);
      console.warn(
        `[wkusb] PinCfg correction: device byte 0x${hex(raw.pinCfg)} → 0x${hex(corrected)} ` +
        `(clearing PTT enable bit)`
      );
      await writer.write(new Uint8Array([0x09, corrected]));
    }

    connected = true;
    emitState('connected');
    emitSettings();
    return true;
  } catch (err) {
    // Bring-up failed midway — try to clean up before surfacing.
    await safeTeardown();
    emitState('error', err);
    throw err;
  }
}

// Cleanly leave host mode and close the port.
export async function disconnect() {
  if (!connected && !port) return;
  connected = false;

  // Tell the device to leave host mode so it returns to standalone defaults.
  if (writer) {
    try {
      await writer.write(ADMIN_HOST_CLOSE);
      await sleep(100);
    } catch (_err) {
      /* no-op */
    }
  }

  await safeTeardown();
  emitState('disconnected');
}

// Send a single character. The character is upper-cased and only printable
// ASCII (0x20–0x7E) is forwarded — other input is silently dropped because
// the WinKeyer protocol uses control bytes in that range as commands.
export function sendChar(ch) {
  if (!connected || !writer) return;
  if (typeof ch !== 'string' || ch.length === 0) return;
  const code = ch.toUpperCase().charCodeAt(0);
  if (code < 0x20 || code > 0x7E) return;
  writer.write(new Uint8Array([code])).catch((err) => {
    console.error('[wkusb] write error', err);
  });
}

// Send a string. Same filtering rules as sendChar.
export function sendText(text) {
  if (!connected || !writer) return;
  if (typeof text !== 'string' || text.length === 0) return;
  const upper = text.toUpperCase();
  const bytes = [];
  for (let i = 0; i < upper.length; i++) {
    const c = upper.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7E) bytes.push(c);
  }
  if (bytes.length === 0) return;
  writer.write(new Uint8Array(bytes)).catch((err) => {
    console.error('[wkusb] write error', err);
  });
}

// Abort whatever the keyer is currently sending. Useful when the operator
// wants to cut off a long buffered string.
export function clearBuffer() {
  if (!connected || !writer) return;
  writer.write(new Uint8Array([0x0A])).catch((err) => {
    console.error('[wkusb] clearBuffer error', err);
  });
}

// ─── Settings (live, mutable, persisted) ───────────────────────────────────

// Returns a snapshot of the current settings — safe for React state. This
// includes every field that contributes to the Mode register and PinCfg
// byte, even ones the UI doesn't currently expose, so the writes are always
// intentional and consistent with the user's stored intent.
export function getSettings() {
  return {
    wpm: settings.wpm,
    maxWpm: settings.maxWpm,
    sidetoneHz: settings.sidetoneHz,
    sidetoneVolume: settings.sidetoneVolume,
    // Mode register
    keyMode: settings.keyMode,
    paddleSwap: settings.paddleSwap,
    autospace: settings.autospace,
    contestSpacing: settings.contestSpacing,
    paddleWatchdog: settings.paddleWatchdog,
    // PinCfg
    ultimaticPriority: settings.ultimaticPriority,
    hangTime: settings.hangTime,
    keyOut1Enabled: settings.keyOut1Enabled,
    keyOut2Enabled: settings.keyOut2Enabled,
    sidetoneEnabled: settings.sidetoneEnabled,
    // Bounds for UI sliders
    minWpm: MIN_WPM,
    protocolMaxWpm: MAX_WPM,
    minSidetoneHz: MIN_SIDETONE_HZ,
    maxSidetoneHz: MAX_SIDETONE_HZ,
  };
}

// Subscribe to settings changes. Fires after each setter applies.
export function onSettings(cb) {
  settingsListeners.add(cb);
  return () => settingsListeners.delete(cb);
}

// All setters except setSidetoneVolume require a live connection. The
// settings panel grays itself out when disconnected, so the early-return
// is purely defensive — but it also documents the new model: there is no
// host-side cache to update, so a setter call with no device is a no-op.

export function setWpm(wpm) {
  if (!connected || !writer) return;
  const clamped = clampWpm(wpm);
  if (clamped === settings.wpm) return;
  settings.wpm = clamped;
  emitSettings();
  writeSafely(new Uint8Array([0x02, clamped]), 'setWpm');
}

export function setSidetoneEnabled(enabled) {
  if (!connected || !writer) return;
  const next = !!enabled;
  if (next === settings.sidetoneEnabled) return;
  settings.sidetoneEnabled = next;
  emitSettings();
  applyPinConfig();
}

export function setSidetoneVolume(level) {
  // Volume is the one setting that persists in localStorage — it's not in
  // the EEPROM Load Defaults map, so we have no way to read it back from
  // the device on connect. Setter works regardless of connection state so
  // the user can pick a level offline; the wire write only fires when
  // connected, and the localStorage cache feeds the next session.
  const lvl = level | 0;
  if (!VALID_SIDETONE_VOLUMES.has(lvl)) return;
  if (lvl === settings.sidetoneVolume) return;
  settings.sidetoneVolume = lvl;
  saveSidetoneVolume(lvl);
  emitSettings();
  if (connected && writer) {
    // Set Sidetone Volume: admin command 25 = wire bytes `00 19 nn` (NOT
    // `00 24 nn` — the manual entry has a typo, see VALID_SIDETONE_VOLUMES
    // comment above for the full story).
    writeSafely(new Uint8Array([0x00, 0x19, lvl]), 'setSidetoneVolume');
  }
}

export function setSidetoneHz(hz) {
  if (!connected || !writer) return;
  const clamped = clampHz(hz);
  if (clamped === settings.sidetoneHz) return;
  settings.sidetoneHz = clamped;
  emitSettings();
  writeSafely(new Uint8Array([0x01, hzToSidetoneByte(clamped)]), 'setSidetoneHz');
}

export function setKeyMode(mode) {
  if (!connected || !writer) return;
  if (!(mode in KEY_MODE_BITS)) return;
  if (mode === settings.keyMode) return;
  settings.keyMode = mode;
  emitSettings();
  // Set WinKeyer Mode (0E nn) — write the full mode register including the
  // preserved paddle-echoback bit and the new key mode field.
  writeSafely(new Uint8Array([0x0E, computeModeRegister()]), 'setKeyMode');
}

export function setMaxWpm(wpm) {
  if (!connected || !writer) return;
  const clamped = clampMaxWpm(wpm);
  if (clamped === settings.maxWpm) return;
  settings.maxWpm = clamped;

  // If the current WPM was above the new max, drag it down so the slider
  // and the device stay in sync.
  let wpmChanged = false;
  if (settings.wpm > clamped) {
    settings.wpm = clamped;
    wpmChanged = true;
  }

  emitSettings();

  // Setup Speed Pot (05 min range pad). Min is fixed at MIN_WPM (5);
  // range is maxWpm - MIN_WPM. Third byte is ignored per the datasheet
  // but must be present for backward compatibility.
  writeSafely(
    new Uint8Array([0x05, MIN_WPM, Math.max(0, clamped - MIN_WPM), 0]),
    'setMaxWpm'
  );
  if (wpmChanged) {
    writeSafely(new Uint8Array([0x02, settings.wpm]), 'setMaxWpm:clampWpm');
  }
}

// Test helper to feed a fake incoming character — used by ChatView while
// developing without hardware. Safe to call regardless of connection state.
export function __debugFeedChar(ch) {
  emitChar(ch);
}

function computePinConfig() {
  let cfg = 0x00;
  // bits 7,6: ultimatic priority
  cfg |= ULTIMATIC_BITS[settings.ultimaticPriority] ?? ULTIMATIC_BITS.normal;
  // bits 5,4: paddle hang time (0..3)
  cfg |= (Math.max(0, Math.min(3, settings.hangTime | 0)) & 0x03) << 4;
  // bit 3: KeyOut 1
  if (settings.keyOut1Enabled) cfg |= 0x08;
  // bit 2: KeyOut 2
  if (settings.keyOut2Enabled) cfg |= 0x04;
  // bit 1: sidetone
  if (settings.sidetoneEnabled) cfg |= 0x02;
  // bit 0 (PTT) is intentionally always 0 — no UI control.
  return cfg;
}

function computeModeRegister() {
  // Bits 6 and 2 are load-bearing: paddle echoback ON, serial echoback OFF.
  // Everything else is built from settings.
  let mode = MODE_PADDLE_ECHO_ON; // 0x40
  // bit 7: DISABLE paddle watchdog (so settings.paddleWatchdog true = bit 0)
  if (!settings.paddleWatchdog) mode |= 0x80;
  // bits 5,4: key mode
  mode |= KEY_MODE_BITS[settings.keyMode] ?? KEY_MODE_BITS.iambicA;
  // bit 3: paddle swap
  if (settings.paddleSwap) mode |= 0x08;
  // bit 2: serial echoback — DO NOT OR IN (load-bearing OFF)
  // bit 1: autospace
  if (settings.autospace) mode |= 0x02;
  // bit 0: contest spacing
  if (settings.contestSpacing) mode |= 0x01;
  return mode;
}

function applyPinConfig() {
  if (!connected || !writer) return;
  writeSafely(new Uint8Array([0x09, computePinConfig()]), 'pinConfig');
}

function writeSafely(bytes, label) {
  writer.write(bytes).catch((err) => {
    console.error(`[wkusb] write error (${label})`, err);
  });
}

function emitSettings() {
  const snapshot = getSettings();
  for (const cb of settingsListeners) {
    try {
      cb(snapshot);
    } catch (err) {
      console.error('[wkusb] settings listener error', err);
    }
  }
}

// ─── Internals ─────────────────────────────────────────────────────────────

async function runReadLoop() {
  try {
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      for (const byte of value) processByte(byte);
    }
  } catch (err) {
    if (err && err.name !== 'AbortError') {
      console.error('[wkusb] read loop error', err);
      emitState('error', err);
    }
  }
}

function processByte(byte) {
  // EEPROM dump bytes are NOT wire-tagged — they're raw memory contents,
  // any value 0x00–0xFF. While capturing, we cannot use the tag bits to
  // route, so every byte goes straight into the dump buffer until we have
  // EEPROM_DUMP_BYTES of them.
  if (readMode === 'EEPROM_CAPTURE') {
    if (dumpBuffer && dumpReceived < dumpExpected) {
      dumpBuffer[dumpReceived++] = byte;
      if (dumpReceived >= dumpExpected) {
        finishDumpCapture(null);
      }
    }
    return;
  }

  // NORMAL mode: WK3 wire format uses the top two bits as a tag:
  //   0b11xxxxxx → status byte
  //   0b10xxxxxx → speed-pot byte
  //   0b0xxxxxxx → echo byte (paddle input or revision code)
  if ((byte & 0xC0) === 0xC0) {
    processStatusByte(byte);
    return;
  }
  if ((byte & 0xC0) === 0x80) {
    // Speed pot value — we don't expose this yet.
    return;
  }
  processEchoByte(byte);
}

// ─── EEPROM dump capture ───────────────────────────────────────────────────

// Arm the read loop to grab the next `expected` raw bytes into a buffer.
// Returns a promise that resolves with the buffer once all bytes have
// arrived, or rejects with an error if the timeout fires first. The caller
// is responsible for sending the Dump EEPROM command AFTER awaiting this
// helper's setup (it's synchronous, so just call it before writing).
function armEepromCapture(expected, timeoutMs) {
  return new Promise((resolve, reject) => {
    dumpBuffer = new Uint8Array(expected);
    dumpReceived = 0;
    dumpExpected = expected;
    readMode = 'EEPROM_CAPTURE';
    dumpResolve = (err, buf) => {
      if (err) reject(err);
      else resolve(buf);
    };
    dumpTimeoutId = setTimeout(() => {
      finishDumpCapture(
        new Error(
          `EEPROM dump timed out after ${timeoutMs} ms (received ${dumpReceived}/${expected} bytes)`
        )
      );
    }, timeoutMs);
  });
}

function finishDumpCapture(err) {
  if (dumpTimeoutId) {
    clearTimeout(dumpTimeoutId);
    dumpTimeoutId = null;
  }
  const buf = dumpBuffer;
  const resolveFn = dumpResolve;
  readMode = 'NORMAL';
  dumpBuffer = null;
  dumpReceived = 0;
  dumpExpected = 0;
  dumpResolve = null;
  if (resolveFn) resolveFn(err, buf);
}

// ─── EEPROM Load Defaults parser ───────────────────────────────────────────

// The first 15 bytes of WK3's EEPROM are close to — but NOT identical
// with — the Load Defaults command's value list. The authoritative layout
// is the WK3 v30 map at data.txt:2500-2517:
//   0  MODEREG           1  FAVEWPM (0=potlock)  2  STCONST (sidetone)
//   3  WEIGHT            4  LEAD                 5  TAIL
//   6  MINWPM            7  WPMRANGE             8  X2MODE
//   9  KCOMP            10  FARNS                11  SAMPADJ
//  12  RATIO            13  PINCFG               14  X1MODE
//
// Key gotcha: byte 1 is FAVEWPM, NOT the current operating speed.
// Favorite speed in WK3 isn't a separate mode — it's a floor on the
// pot range. When FAVEWPM > 0, the pot operates from FAVEWPM (at
// fully-CCW) up to the pot's max, so "turn the pot all the way down"
// gives you that saved speed. When FAVEWPM == 0 ("potlock" per the
// manual), the pot runs continuously over its full MinWPM..maxWpm
// range with no floor.
//
// That means:
//   - FAVEWPM > 0  → a real, stored speed value worth showing in the UI
//                    (it's what the device uses whenever the pot is CCW,
//                    which is the only fixed reference we have from EEPROM)
//   - FAVEWPM == 0 → no useful speed info in EEPROM; current speed is
//                    wherever the pot happens to be physically set
//
// We read byte 1 when it's non-zero and fall back to the slider midpoint
// as a neutral placeholder when it's 0. The first Set Speed (02 nn) the
// user triggers by moving the slider overrides whatever the device was
// doing, so this is purely a presentation question — no wire writes fire
// at connect time regardless of which branch runs.
//
// TODO: the "proper" fix for potlock devices is to capture the
// 0b10xxxxxx speed-pot bytes in runReadLoop() — the device emits one
// automatically whenever the pot moves, and almost certainly sends an
// initial reading after Host Open. Would give us the true live speed.
//
// Returns { raw, parsed } where:
//   raw    = { modeReg, pinCfg } — kept verbatim for the correction checks
//   parsed = a partial settings shape ready to Object.assign into `settings`
function parseLoadDefaults(eeprom) {
  if (!eeprom || eeprom.length < 15) {
    throw new Error(`EEPROM dump too short: need 15 bytes, got ${eeprom ? eeprom.length : 0}`);
  }

  const modeReg = eeprom[0];
  const faveWpm = eeprom[1]; // FAVEWPM: 0 = potlock, >0 = saved favorite speed
  const sidetoneByte = eeprom[2];
  // bytes 3,4,5: weight, lead-in, tail — not exposed in the UI
  const minWpm = eeprom[6];
  const wpmRange = eeprom[7];
  // bytes 8..12: x2 mode, key comp, farnsworth, paddle setpoint, dit/dah — not exposed
  const pinCfg = eeprom[13];
  // byte 14: x1 mode — not exposed

  const keyMode = KEY_MODE_BY_BITS[modeReg & 0x30] ?? 'iambicA';
  const ultimaticPriority = ULTIMATIC_BY_BITS[pinCfg & 0xC0] ?? 'normal';

  // Sidetone byte → Hz via inverse of hzToSidetoneByte. Guard against a
  // zero byte (would divide-by-zero) by clamping to the protocol minimum.
  const sidetoneHz =
    sidetoneByte > 0
      ? Math.max(MIN_SIDETONE_HZ, Math.min(MAX_SIDETONE_HZ, Math.round(62500 / sidetoneByte)))
      : MIN_SIDETONE_HZ;

  // maxWpm = MinWPM + WPM Range, clamped to a sane UI bound.
  const maxWpmRaw = (minWpm | 0) + (wpmRange | 0);
  const maxWpm = Math.max(MIN_WPM + 5, Math.min(MAX_WPM, maxWpmRaw || 35));

  // WPM seed: if the device has a non-zero FAVEWPM stored, use that —
  // it's the speed the device is at when the pot is CCW, which is the
  // closest thing to a "stored current speed" EEPROM gives us. If byte 1
  // is 0 (potlock), fall back to the slider midpoint as a neutral
  // placeholder. Either way no Set Speed command fires at connect time,
  // so this is purely visual until the user moves the slider.
  const wpm =
    faveWpm > 0
      ? Math.max(MIN_WPM, Math.min(maxWpm, faveWpm))
      : Math.round((MIN_WPM + maxWpm) / 2);

  return {
    raw: { modeReg, pinCfg },
    parsed: {
      // Mode register fields
      paddleWatchdog: (modeReg & 0x80) === 0, // bit 7 SET = watchdog disabled
      keyMode,
      paddleSwap: (modeReg & 0x08) !== 0,
      autospace: (modeReg & 0x02) !== 0,
      contestSpacing: (modeReg & 0x01) !== 0,
      // Speed
      wpm,
      maxWpm,
      // Sidetone freq
      sidetoneHz,
      // PinCfg fields
      ultimaticPriority,
      hangTime: (pinCfg >> 4) & 0x03,
      keyOut1Enabled: (pinCfg & 0x08) !== 0,
      keyOut2Enabled: (pinCfg & 0x04) !== 0,
      sidetoneEnabled: (pinCfg & 0x02) !== 0,
    },
  };
}

// ─── Correction helpers ────────────────────────────────────────────────────

function needsModeCorrection(byte) {
  // Bit 6 must be 1 (paddle echo on) and bit 2 must be 0 (serial echo off).
  return (byte & MODE_PADDLE_ECHO_ON) === 0 || (byte & MODE_SERIAL_ECHO_ON) !== 0;
}

function correctModeRegister(byte) {
  return (byte | MODE_PADDLE_ECHO_ON) & ~MODE_SERIAL_ECHO_ON & 0xFF;
}

function needsPinCfgCorrection(byte) {
  // Bit 0 (PTT enable) must be 0.
  return (byte & PIN_CFG_PTT_ON) !== 0;
}

function correctPinCfg(byte) {
  return byte & ~PIN_CFG_PTT_ON & 0xFF;
}

function hex(byte) {
  return byte.toString(16).padStart(2, '0');
}

function processStatusByte(byte) {
  const nextBusy = (byte & STATUS_BUSY) !== 0;
  // BREAKIN and XOFF aren't surfaced yet — leaving the masks named for clarity.
  void (byte & STATUS_BREAKIN);
  void (byte & STATUS_XOFF);

  if (nextBusy !== busy) {
    busy = nextBusy;
    emitState(busy ? 'busy' : 'idle');
  }
}

function processEchoByte(byte) {
  if (expectingRevision) {
    // First echo byte after host open is the firmware revision code, not
    // paddle input. Discard it and clear the flag.
    expectingRevision = false;
    return;
  }
  if (byte === 0x03) {
    // Echo of host-close ack. Ignore.
    return;
  }
  if (byte === 0x00) {
    // Null padding. Ignore.
    return;
  }
  if (byte >= 0x20 && byte <= 0x7E) {
    emitChar(String.fromCharCode(byte));
  }
}

function emitChar(ch) {
  for (const cb of charListeners) {
    try {
      cb(ch);
    } catch (err) {
      console.error('[wkusb] char listener error', err);
    }
  }
}

function emitState(state, err) {
  for (const cb of stateListeners) {
    try {
      cb(state, err);
    } catch (cbErr) {
      console.error('[wkusb] state listener error', cbErr);
    }
  }
}

async function safeTeardown() {
  if (reader) {
    try { await reader.cancel(); } catch (_err) { /* no-op */ }
    try { reader.releaseLock(); } catch (_err) { /* no-op */ }
    reader = null;
  }
  if (readLoopPromise) {
    try { await readLoopPromise; } catch (_err) { /* no-op */ }
    readLoopPromise = null;
  }
  if (writer) {
    try { writer.releaseLock(); } catch (_err) { /* no-op */ }
    writer = null;
  }
  if (port) {
    try { await port.close(); } catch (_err) { /* no-op */ }
    port = null;
  }
  busy = false;
  expectingRevision = false;
  // Tear down any in-flight dump capture so a future connect starts clean.
  if (dumpResolve) {
    finishDumpCapture(new Error('disconnected mid-dump'));
  }
  readMode = 'NORMAL';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
