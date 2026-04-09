// WKUSB / WKMini / WKUSB-AF integration over Web Serial.
//
// Boundary between the chat UI and the K1EL WinKeyer 3 hardware. The protocol
// transcript I followed is in this repo's `data.pdf`; the bring-up sequence
// (host open → set WK3 mode → load defaults) is modeled on a known-working
// implementation in another project.
//
// Web Serial requirements:
//   - Chrome or Edge (no Firefox / Safari support)
//   - HTTPS or http://localhost
//   - A user gesture to call navigator.serial.requestPort()
//
// Routing model (only paddle echoback is enabled, serial echoback is OFF):
//   - sendText(): writes ASCII bytes the device plays as Morse via sidetone
//     and the configured KEY output. The device does NOT echo these back.
//   - Any echo byte we receive is therefore from the operator's paddles, and
//     gets dispatched via onChar() into the chat layer.
//
// All numeric constants are documented inline; if you change them, double-
// check against `data.pdf` (Mode register, X1/X2 mode, PinCfg).

// ─── Protocol constants ────────────────────────────────────────────────────

// Admin commands (always prefixed with 0x00).
const ADMIN_HOST_OPEN     = new Uint8Array([0x00, 0x02]);
const ADMIN_HOST_CLOSE    = new Uint8Array([0x00, 0x03]);
const ADMIN_SET_WK3_MODE  = new Uint8Array([0x00, 0x14]); // admin 20

// Fixed init bytes pushed after Host Open (per user spec 2026-04-08). These
// are intentionally hardcoded — NOT derived from `settings` — so the
// routing-critical bits (Mode bit 6 paddle echo on, bit 2 serial echo off)
// are guaranteed regardless of the device's standalone EEPROM state or any
// stale value in the user's localStorage. The settings panel can still
// change these registers afterwards via the per-setter commands.
//   PinCfg 0x02 = sidetone on, all key outputs and PTT off, hang time 0,
//                 ultimatic priority normal.
//   Mode   0x50 = paddle watchdog enabled, paddle echoback ON, iambic A,
//                 paddle swap off, serial echoback OFF, autospace off,
//                 contest spacing off.
const INIT_PIN_CFG  = new Uint8Array([0x09, 0x02]);
const INIT_MODE_REG = new Uint8Array([0x0E, 0x50]);

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
const MODE_PADDLE_ECHO_ON = 0x40;

// Key mode bit values for mode register bits 5,4. The wire mapping is:
//   00 = Iambic B (0x00),  01 = Iambic A (0x10),
//   10 = Ultimatic (0x20), 11 = Bug      (0x30)
const KEY_MODE_BITS = {
  iambicB:   0x00,
  iambicA:   0x10,
  ultimatic: 0x20,
  bug:       0x30,
};

// ─── PinCfg layout (Set PinConfig, command 0x09) ──────────────────────────
//
// Bits 7,6: Ultimatic priority (00 normal, 01 dah, 10 dit, 11 undef).
// Bits 5,4: Paddle hang time (0..3 → 1ws + {1,2,4,8} dits).
// Bit 3: KeyOut 1 enable.
// Bit 2: KeyOut 2 enable.
// Bit 1: Sidetone enable.
// Bit 0: PTT enable.
//
// computePinConfig() builds the entire byte from settings — no fields are
// load-bearing for the routing model.
const ULTIMATIC_BITS = {
  normal: 0x00,
  dah:    0x40,
  dit:    0x80,
};

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

// localStorage key for settings persistence.
const SETTINGS_KEY = 'morseChat.wkusbSettings';

// Default settings — chosen so the computed bytes exactly match the fixed
// init writes connect() pushes (INIT_PIN_CFG = 0x02, INIT_MODE_REG = 0x50).
// Keeping defaults aligned means a fresh user starts with the host snapshot
// and the device state in agreement; existing localStorage may still drift
// from the device after init until the user touches a setting.
function defaultSettings() {
  return {
    // Speed
    wpm: 20,
    maxWpm: 35,

    // Sidetone freq (Sidetone Control 0x01 nn)
    sidetoneHz: 553, // ~ 0x71

    // Sidetone volume level 1..4 (Set Sidetone Volume 00 19 nn). Default
    // mid-range; the user can crank to 4 or drop to 1 from the panel.
    sidetoneVolume: 3,

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
    keyOut2Enabled: false,        // bit 2 — matches INIT_PIN_CFG (0x02)
    sidetoneEnabled: true,        // bit 1
    // bit 0 (PTT) is always 0 — no UI control, no setter.
  };
}

function loadSettings() {
  try {
    if (typeof window === 'undefined') return defaultSettings();
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw);
    return { ...defaultSettings(), ...parsed };
  } catch (_err) {
    return defaultSettings();
  }
}

function saveSettings() {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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

// Live, mutable settings (persisted via localStorage). The connect() bring-up
// reads from here so that values set while disconnected take effect on the
// next connection.
const settings = loadSettings();

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

  // The first echo byte after Admin:Host Open is the firmware revision code,
  // not paddle input — flag it so the read loop discards it.
  expectingRevision = true;

  // Start the read loop before we send anything so we don't miss the
  // revision code byte.
  readLoopPromise = runReadLoop();

  try {
    await writer.write(ADMIN_HOST_OPEN);
    // Brief settle so the device emits the revision code (which the read
    // loop discards via expectingRevision) before we send any further
    // commands.
    await sleep(150);

    // Bring-up sequence (per user spec 2026-04-08): switch to WK3 mode,
    // then push a known-good PinCfg and Mode register so the chat→pair
    // routing model is guaranteed regardless of EEPROM standalone state.
    // The previous policy of "minimal connect, push nothing" left paddle
    // echoback at the mercy of the device's standalone Mode register and
    // surfaced as a bug where one operator's keying never reached the host.
    await writer.write(ADMIN_SET_WK3_MODE);
    await writer.write(INIT_PIN_CFG);
    await writer.write(INIT_MODE_REG);

    connected = true;
    emitState('connected');
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

export function setWpm(wpm) {
  const clamped = clampWpm(wpm);
  if (clamped === settings.wpm) return;
  settings.wpm = clamped;
  saveSettings();
  emitSettings();
  if (connected && writer) {
    writeSafely(new Uint8Array([0x02, clamped]), 'setWpm');
  }
}

export function setSidetoneEnabled(enabled) {
  const next = !!enabled;
  if (next === settings.sidetoneEnabled) return;
  settings.sidetoneEnabled = next;
  saveSettings();
  emitSettings();
  applyPinConfig();
}

export function setSidetoneVolume(level) {
  const lvl = level | 0;
  if (!VALID_SIDETONE_VOLUMES.has(lvl)) return;
  if (lvl === settings.sidetoneVolume) return;
  settings.sidetoneVolume = lvl;
  saveSettings();
  emitSettings();
  if (connected && writer) {
    // Set Sidetone Volume: admin command 25 = wire bytes `00 19 nn` (NOT
    // `00 24 nn` — the manual entry has a typo, see VALID_SIDETONE_VOLUMES
    // comment above for the full story).
    writeSafely(new Uint8Array([0x00, 0x19, lvl]), 'setSidetoneVolume');
  }
}

export function setSidetoneHz(hz) {
  const clamped = clampHz(hz);
  if (clamped === settings.sidetoneHz) return;
  settings.sidetoneHz = clamped;
  saveSettings();
  emitSettings();
  if (connected && writer) {
    writeSafely(new Uint8Array([0x01, hzToSidetoneByte(clamped)]), 'setSidetoneHz');
  }
}

export function setKeyMode(mode) {
  if (!(mode in KEY_MODE_BITS)) return;
  if (mode === settings.keyMode) return;
  settings.keyMode = mode;
  saveSettings();
  emitSettings();
  if (connected && writer) {
    // Set WinKeyer Mode (0E nn) — write the full mode register including
    // the preserved paddle-echoback bit and the new key mode field.
    writeSafely(new Uint8Array([0x0E, computeModeRegister()]), 'setKeyMode');
  }
}

export function setMaxWpm(wpm) {
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

  saveSettings();
  emitSettings();

  if (connected && writer) {
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
  // WK3 wire format uses the top two bits as a tag:
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
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
