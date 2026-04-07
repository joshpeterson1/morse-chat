import { useEffect, useState } from 'react';
import { inboxChannelName } from '../lib/channels.js';

// Subscribes to the user's personal inbox channel and exposes:
// - pendingIncoming: { from } when another user has requested to connect
// - outgoingResult: { type: 'accept' | 'decline', from } when a user we
//   requested has responded
//
// The caller (App) is responsible for clearing these when handled.
export function useInbox(client, callsign) {
  const [pendingIncoming, setPendingIncoming] = useState(null);
  const [outgoingResult, setOutgoingResult] = useState(null);

  useEffect(() => {
    if (!client || !callsign) return;

    const channel = client.channels.get(inboxChannelName(callsign));

    function onMessage(msg) {
      const from = (msg.data && msg.data.from) || msg.clientId;
      if (!from || from === callsign) return;

      switch (msg.name) {
        case 'connection-request':
          setPendingIncoming({ from });
          break;
        case 'connection-accept':
          setOutgoingResult({ type: 'accept', from });
          break;
        case 'connection-decline':
          setOutgoingResult({ type: 'decline', from });
          break;
        default:
          break;
      }
    }

    channel.subscribe(onMessage);
    return () => {
      channel.unsubscribe(onMessage);
    };
  }, [client, callsign]);

  return {
    pendingIncoming,
    setPendingIncoming,
    outgoingResult,
    setOutgoingResult,
  };
}
