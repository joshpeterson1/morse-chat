# somber's morse chat

A web app that lets ham operators connect over the internet and exchange Morse code through their **WKUSB / WKMini / WKUSB-AF** devices. Built on Vite + React with Ably Pub/Sub for the real-time layer and a single Vercel serverless function for token auth.

> **Status:** Fully wired end-to-end including the WKUSB Web Serial integration (K1EL WinKeyer 3 host mode). You can also use it without a device — the chat input is a typed-input fallback that publishes the same way paddle input does.

> **Datasheet:** `data.pdf` at the project root is the K1EL WinKeyer 3 reference. If you change protocol bytes in `src/lib/wkusb.js`, double-check against it.

## Stack

- **Frontend:** Vite + React (SPA)
- **Real-time:** [Ably Pub/Sub](https://ably.com/) — presence channel for the user list, per-user inbox channels for connection signaling, deterministic pair channels for in-session messages
- **Auth:** Vercel serverless function (`api/ably-token.js`) issues short-lived Ably token requests so the API key never reaches the browser
- **Hosting:** Vercel (frontend + the single API route)

## Project layout

```
api/
  ably-token.js          # Vercel serverless: signs Ably token requests
src/
  main.jsx               # React entrypoint
  App.jsx                # Top-level state machine (callsign → online → paired)
  styles.css
  lib/
    ably.js              # Ably Realtime client factory
    channels.js          # Channel name conventions
    messaging.js         # connection-request / accept / decline publish helpers
    wkusb.js             # WKUSB Web Serial stub (TODO: real implementation)
  hooks/
    useCallsign.js       # localStorage-backed identity
    useAblyClient.js     # Realtime client lifecycle
    usePresence.js       # Lobby presence membership
    useInbox.js          # Personal inbox channel for signaling
    usePairChannel.js    # Paired-session channel for live text
  components/
    CallsignEntry.jsx
    OnlineToggle.jsx
    UserList.jsx
    ConnectionRequest.jsx
    OutgoingRequest.jsx
    ChatView.jsx
```

## Running locally

You need both the Vite dev server **and** the serverless function for the token endpoint, so use `vercel dev` (Vite alone won't serve `/api/*`).

```bash
npm install
cp .env.example .env          # then fill in ABLY_API_KEY
npx vercel dev
```

Open http://localhost:3000.

If you'd rather skip the serverless function while iterating purely on UI, you can run `npm run dev` — but Ably auth will fail because nothing answers `/api/ably-token`.

## Deploying to Vercel

1. Push the repo to GitHub.
2. Import the repo in Vercel.
3. Add `ABLY_API_KEY` as an environment variable (Production / Preview / Development).
4. Deploy. The `api/ably-token.js` function deploys automatically.

The Vite app and the serverless function share one Vercel project — there's no separate backend to host.

## How the protocol works

Three kinds of channels:

| Channel | Purpose |
|---|---|
| `morse:lobby` | Shared presence channel. Anyone who toggles "appear online" enters here; the membership IS the user list. |
| `morse:inbox:<callsign>` | One per user. Others publish `connection-request`, `connection-accept`, `connection-decline` events here to signal that user out-of-band. |
| `morse:pair:<a>\|<b>` | Sorted pair channel. Once two users are paired they exchange `morse-text` events here, plus a final `disconnect` to end the session. |

Connection flow:

1. A clicks **Connect** on B's row → A publishes `connection-request` to `morse:inbox:B`.
2. B sees a modal → clicks Accept → B publishes `connection-accept` to `morse:inbox:A`, both subscribe to `morse:pair:A|B`.
3. Either side publishes `morse-text` events on the pair channel; characters render live.
4. Either side publishes `disconnect` (or just navigates away) to end the session.

Mutual-connect race (A and B click each other at the same time): App treats the second incoming as auto-accept.

## WKUSB / WKMini / WKUSB-AF

`src/lib/wkusb.js` talks to the K1EL WinKeyer 3 over Web Serial. Public API:

```js
isWebSerialSupported()
isConnected()
isBusy()
connect()              // requests a port, opens at 1200 8N1, host-mode handshake
disconnect()           // sends host close, releases locks, closes port
sendChar(ch)           // upper-cased; non-printable bytes filtered
sendText(text)
clearBuffer()          // 0x0A — abort whatever the keyer is currently sending
onChar(cb)             // paddle-sourced ASCII chars from the device
onState(cb)            // 'connected' | 'disconnected' | 'busy' | 'idle' | 'error'
__debugFeedChar(ch)    // test helper to simulate incoming chars
```

**Bring-up sequence** (mirrors the K1EL datasheet, see `data.pdf`):

1. `navigator.serial.requestPort()` (must be from a click — Web Serial gesture rule)
2. `port.open({ baudRate: 1200, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' })`
3. Start the read loop **before** writing anything so the revision-code echo isn't dropped
4. Write `00 02` (Admin: Host Open). The first echo byte is the firmware revision — discarded

That's it. We deliberately push **no init defaults** — no Set WK3 Mode, no Load Defaults block, nothing. The device keeps whatever settings it had standalone, and user-set values only reach the device when the user actively touches a control in the settings panel (which fires the focused per-setting command, e.g. Set Speed `02 nn`).

This was a deliberate fallback after a Load Defaults / Set WK3 Mode / Set Sidetone Volume sequence broke the host-open handshake on real hardware. If you want to re-enable a particular init write, do it via the focused command, not the bulk Load Defaults block.

**Echo discipline.** Mode register `0x50` enables paddle echoback (bit 6) and **disables** serial echoback (bit 2). That means:

- ASCII bytes we write play as Morse on sidetone + KeyOut2 but the device does **not** echo them back to us — no need to filter our own writes.
- Any echo byte we read is the operator pressing paddles. We dispatch it via `onChar` and the chat layer publishes it on the pair channel.

**Read-loop byte tags.** The WK3 wire format uses the top two bits as a tag:

| Pattern  | Type     | Handling                                          |
|----------|----------|---------------------------------------------------|
| `11xxxxxx` | Status   | BUSY/BREAKIN/XOFF bits — emits `busy` / `idle` |
| `10xxxxxx` | Speed pot | Ignored (no UI for it yet)                       |
| `0xxxxxxx` | Echo     | Paddle char or revision code or null padding     |

**Routing in the chat view.** With a device connected:

| Source                       | → pair channel | → local WKUSB | → chat stream |
|------------------------------|----------------|----------------|----------------|
| Local typing / paste         | yes            | yes (heard locally) | yes (local echo) |
| Local paddle (WKUSB onChar)  | yes            | no (already played) | yes (local echo) |
| Remote `morse-text`          | n/a            | yes (heard locally) | yes (incoming) |

**Pin config defaults.** The base PinCfg is `0x04` (KeyOut2 only). Sidetone (bit 1) and PTT (bit 0) are flipped at runtime via the settings panel. KeyOut1 is unused — if your wiring needs it, change `PIN_CONFIG_BASE` at the top of `wkusb.js`.

**Live settings.** A collapsible panel below the connection bar exposes the user-tunable WK3 controls. Settings persist in `localStorage` (`morseChat.wkusbSettings`) and apply immediately on a connected device:

| Setting | Wire command | Notes |
|---|---|---|
| WPM | `02 nn` | nn = 5–maxWpm; slider upper bound = max speed |
| Max speed | `05 min range pad` | Setup Speed Pot; min fixed at 5, range = max−5. Also clamps current WPM. |
| Key mode | `0E nn` | Set WinKeyer Mode. nn = `MODE_REGISTER_BASE \| KEY_MODE_BITS[mode]`. Bits 5,4: 00 Iambic B, 01 Iambic A, 10 Ultimatic, 11 Bug. |
| Sidetone freq | `01 nn` | nn = 62500 / Hz, clamped 500–1500 Hz in the UI |
| Sidetone on/off | `09 nn` | rebuilds PinCfg with bit 1 toggled |
| PTT on/off | `09 nn` | rebuilds PinCfg with bit 0 toggled |

Sidetone volume is **not** exposed — Admin Set Volume (`00 24 nn`) was breaking the host-open handshake on the test hardware, so it's been removed from the bring-up and the panel.

The mode-register write preserves paddle echoback (bit 6) and serial-echoback-off (bit 2) — those are load-bearing for the routing model and can't be flipped from the UI.

When the device isn't connected, setter calls still update `localStorage` and the in-memory settings — the new values get pushed in the Load Defaults block (and the Sidetone Volume admin command) on the next `connect()`.

## Notes & limitations

- Callsigns are stored in `localStorage`, sanitized (uppercase, alphanumeric + `/`, max 16 chars). No accounts, no validation — trust on first use.
- The token endpoint scopes the Ably token to the requested clientId, so users can't impersonate the *server* but they can pick whatever callsign they want.
- Each typed character is one Ably publish. Fine for chat traffic; if you wire up real keying you'll likely want to coalesce bursts.
- The app does not persist message history. If you reload mid-session, the pair is gone.
- One-on-one only by design — no group sessions.
