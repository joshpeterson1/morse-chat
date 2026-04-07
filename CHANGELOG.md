# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **`Set PinCfg` and `Set WinKeyer Mode` no longer clobber unrelated bits.** The K1EL protocol writes the entire byte for both registers and offers no register read-back, so the previous live setters were silently zeroing hang time, ultimatic priority, paddle swap, autospace, contest spacing, and the paddle watchdog disable bit on every toggle. The settings object now tracks the **full** state of both registers; `computeModeRegister()` and `computePinConfig()` build the byte from every field. Defaults mirror the working reference at `newqrzframe/public/wkusb-manager.js` (`defaultModeRegister = 0x50`, `defaultPinConfig = 0x06`); a default-state round-trip produces exactly those bytes. Bits 6 (paddle echoback ON) and 2 (serial echoback OFF) of the mode register remain forced because they're load-bearing for the chat→pair routing model.

### Added
- WKUSB settings panel (collapsible, below the connection bar) with sliders/toggles for WPM speed, **max speed (slider upper bound)**, **key mode (Iambic A/B/Ultimatic/Bug)**, sidetone on/off, sidetone frequency (500–1500 Hz), and PTT enable. Settings persist in `localStorage` (`morseChat.wkusbSettings`) and are applied live to the device when connected — or staged for next connect when offline.
- Public setter API on `src/lib/wkusb.js`: `setWpm`, `setMaxWpm`, `setSidetoneEnabled`, `setSidetoneHz`, `setKeyMode`, `setPttEnabled`, plus `getSettings` / `onSettings` for state subscription. Wire commands: WPM = Set Speed (`02 nn`), max WPM = Setup Speed Pot (`05 min range pad`), sidetone freq = Sidetone Control (`01 nn`, byte = 62500 / Hz), key mode = Set WinKeyer Mode (`0E nn`) with the mode-register field rebuilt from `MODE_REGISTER_BASE | KEY_MODE_BITS[mode]`, sidetone enable + PTT enable rebuild PinCfg from `PIN_CONFIG_BASE | flags` and write Set PinCfg (`09 nn`).

### Removed
- **Sidetone volume control.** The Admin Set Volume command (`00 24 nn`) was breaking connection on the user's hardware. Setting, setter, hook export, panel UI, and the post-Load-Defaults volume write are all gone.
- **All init defaults pushed at connect time.** The `connect()` bring-up no longer sends `Set WK3 Mode` (`00 14`) nor the `Load Defaults` block (`0F` + 15 values). After the host-open handshake the device retains whatever settings it had standalone. User-set values are only pushed when the user actively changes a control in the settings panel — that path uses the focused per-setting commands which are known-safe.

### Notes
- Setting max WPM clamps the current WPM downward if it exceeded the new max, then pushes both Setup Speed Pot and Set Speed in one go so the device and slider stay in sync.

### Changed
- Branded the app as "somber's morse chat" (browser tab title and in-app header).
- `src/lib/wkusb.js` is no longer a stub: real Web Serial integration for WKUSB / WKMini / WKUSB-AF using the K1EL WinKeyer 3 protocol. Connect at 1200 8N1, host-open handshake (`00 02`) with revision-code discard, then `00 14` (Set WK3 Mode) followed by Load Defaults (`0F` + 15 values). Mode register `0x50` enables paddle echoback and disables serial echoback so we never receive our own writes back. Read loop classifies bytes by tag (status / speed-pot / echo) and dispatches paddle-sourced ASCII to `onChar` listeners. Adds `onState`, `clearBuffer`, and `isBusy` to the public API.
- ChatView now plays remote `morse-text` on the local WKUSB (so the operator hears their partner's keying), and locally typed/pasted characters also go to the WKUSB so they're heard/transmitted alongside being published. Paddle-sourced characters are sent to the pair channel but never looped back to the device.

### Added
- `useWkusb` hook (`src/hooks/useWkusb.js`) wrapping the wkusb singleton with React state for `connected` / `connecting` / `busy` / `error`.
- `WkusbBar` component (`src/components/WkusbBar.jsx`) — Connect / Disconnect button + status pill, surfaced above the lobby and chat views in `App.jsx`.
- Initial Vite + React scaffold targeting Vercel.
- Vercel serverless function `api/ably-token.js` that signs short-lived Ably token requests scoped to a callsign clientId, keeping `ABLY_API_KEY` server-side.
- Ably Realtime client wrapper (`src/lib/ably.js`) authenticating via the token endpoint.
- Channel name conventions (`src/lib/channels.js`): `morse:lobby` for presence, `morse:inbox:<callsign>` for connection signaling, `morse:pair:<a>|<b>` for paired sessions.
- Signaling helpers (`src/lib/messaging.js`) for connection-request / accept / decline.
- Hooks: `useCallsign` (localStorage identity), `useAblyClient` (Realtime lifecycle), `usePresence` (lobby membership), `useInbox` (incoming + outgoing-result events), `usePairChannel` (live text + disconnect).
- UI components: CallsignEntry, OnlineToggle, UserList, ConnectionRequest, OutgoingRequest, ChatView, plus the App shell that wires them together.
- Mutual-connect race handling (auto-accept when both sides request each other simultaneously).
- WKUSB stub at `src/lib/wkusb.js` with the connect / sendChar / onChar interface and TODOs for the WinKeyer Web Serial protocol bring-up. ChatView already routes incoming WKUSB chars into the outgoing pair channel.
- Project README documenting stack, layout, run instructions, and the wire protocol.
