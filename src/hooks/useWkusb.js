import { useEffect, useState } from 'react';
import {
  isWebSerialSupported,
  isConnected,
  isBusy,
  connect as wkusbConnect,
  disconnect as wkusbDisconnect,
  onState,
  onSettings,
  getSettings,
  setWpm as wkusbSetWpm,
  setMaxWpm as wkusbSetMaxWpm,
  setSidetoneEnabled as wkusbSetSidetoneEnabled,
  setSidetoneHz as wkusbSetSidetoneHz,
  setKeyMode as wkusbSetKeyMode,
  setPttEnabled as wkusbSetPttEnabled,
} from '../lib/wkusb.js';

// React-side wrapper around the singleton wkusb module. Tracks connection
// + busy state and exposes connect / disconnect handlers. The underlying
// module is a singleton because the WKUSB device is global to the page —
// there's only ever one COM port — so this hook just mirrors that state.
export function useWkusb() {
  const [supported] = useState(() => isWebSerialSupported());
  const [connected, setConnected] = useState(() => isConnected());
  const [busy, setBusy] = useState(() => isBusy());
  const [error, setError] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [settings, setSettings] = useState(() => getSettings());

  useEffect(() => {
    return onState((state, err) => {
      switch (state) {
        case 'connected':
          setConnected(true);
          setError(null);
          break;
        case 'disconnected':
          setConnected(false);
          setBusy(false);
          break;
        case 'busy':
          setBusy(true);
          break;
        case 'idle':
          setBusy(false);
          break;
        case 'error':
          setError(err || new Error('WKUSB error'));
          break;
        default:
          break;
      }
    });
  }, []);

  useEffect(() => {
    return onSettings((next) => setSettings(next));
  }, []);

  async function connect() {
    if (connecting || connected) return;
    setConnecting(true);
    setError(null);
    try {
      await wkusbConnect();
    } catch (err) {
      // requestPort cancelled by the user is a NotFoundError — silently swallow.
      if (err && err.name !== 'NotFoundError') {
        setError(err);
        console.error('[wkusb] connect failed', err);
      }
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    try {
      await wkusbDisconnect();
    } catch (err) {
      console.error('[wkusb] disconnect failed', err);
    }
  }

  return {
    supported,
    connected,
    connecting,
    busy,
    error,
    connect,
    disconnect,
    settings,
    setWpm: wkusbSetWpm,
    setMaxWpm: wkusbSetMaxWpm,
    setSidetoneEnabled: wkusbSetSidetoneEnabled,
    setSidetoneHz: wkusbSetSidetoneHz,
    setKeyMode: wkusbSetKeyMode,
    setPttEnabled: wkusbSetPttEnabled,
  };
}
