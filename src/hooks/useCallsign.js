import { useCallback, useState } from 'react';

const KEY = 'morseChat.callsign';

function sanitize(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^A-Z0-9/]/g, '')
    .slice(0, 16);
}

export function useCallsign() {
  const [callsign, setCallsignState] = useState(() => {
    if (typeof window === 'undefined') return '';
    return sanitize(window.localStorage.getItem(KEY) || '');
  });

  const setCallsign = useCallback((next) => {
    const clean = sanitize(next);
    setCallsignState(clean);
    if (clean) {
      window.localStorage.setItem(KEY, clean);
    } else {
      window.localStorage.removeItem(KEY);
    }
  }, []);

  return [callsign, setCallsign];
}
