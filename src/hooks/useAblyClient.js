import { useEffect, useState } from 'react';
import { createAblyClient } from '../lib/ably.js';

// Owns the lifetime of the Ably Realtime client. Recreates it whenever the
// callsign changes (which means a new identity / new token), and tears it
// down when the callsign is cleared or the component unmounts.
export function useAblyClient(callsign) {
  const [client, setClient] = useState(null);
  const [state, setState] = useState('initialized');

  useEffect(() => {
    if (!callsign) {
      setClient(null);
      setState('initialized');
      return;
    }

    const c = createAblyClient(callsign);
    setClient(c);
    setState(c.connection.state);

    const onState = (change) => setState(change.current);
    c.connection.on(onState);

    return () => {
      c.connection.off(onState);
      try {
        c.close();
      } catch (_err) {
        /* no-op */
      }
    };
  }, [callsign]);

  return { client, state };
}
