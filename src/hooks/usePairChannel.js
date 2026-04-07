import { useEffect, useRef, useState } from 'react';
import { pairChannelName } from '../lib/channels.js';

// Subscribes to the deterministic pair channel for two callsigns and exposes
// the running message log plus helpers for sending text and a final
// disconnect signal. The caller passes onRemoteDisconnect to be notified when
// the other side ends the session.
export function usePairChannel(client, me, them, onRemoteDisconnect) {
  const [messages, setMessages] = useState([]);
  const channelRef = useRef(null);

  useEffect(() => {
    if (!client || !me || !them) return;

    const channel = client.channels.get(pairChannelName(me, them));
    channelRef.current = channel;
    setMessages([]);

    function onMessage(msg) {
      if (msg.name === 'morse-text') {
        setMessages((prev) => [
          ...prev,
          {
            from: msg.clientId === me ? 'me' : 'them',
            text: (msg.data && msg.data.text) || '',
            ts: msg.timestamp || Date.now(),
          },
        ]);
      } else if (msg.name === 'disconnect') {
        if (msg.clientId !== me && onRemoteDisconnect) {
          onRemoteDisconnect();
        }
      }
    }

    channel.subscribe(onMessage);
    return () => {
      channel.unsubscribe(onMessage);
      channelRef.current = null;
    };
  }, [client, me, them, onRemoteDisconnect]);

  function sendText(text) {
    const ch = channelRef.current;
    if (!ch || !text) return;
    ch.publish('morse-text', { text });
    // Local echo because echoMessages is disabled on the client.
    setMessages((prev) => [
      ...prev,
      { from: 'me', text, ts: Date.now() },
    ]);
  }

  function sendDisconnect() {
    const ch = channelRef.current;
    if (!ch) return;
    try {
      ch.publish('disconnect', {});
    } catch (_err) {
      /* no-op */
    }
  }

  return { messages, sendText, sendDisconnect };
}
