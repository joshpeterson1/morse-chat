import { useEffect, useState } from 'react';
import { LOBBY_CHANNEL } from '../lib/channels.js';

// When `online` is true, enters the shared lobby presence channel as the
// current callsign. Subscribes to membership changes and exposes the current
// list of online clientIds (callsigns).
export function usePresence(client, online) {
  const [members, setMembers] = useState([]);

  useEffect(() => {
    if (!client) {
      setMembers([]);
      return;
    }

    const channel = client.channels.get(LOBBY_CHANNEL);
    let cancelled = false;

    async function refresh() {
      try {
        const list = await channel.presence.get();
        if (!cancelled) setMembers(list.map((m) => m.clientId));
      } catch (err) {
        console.error('presence get error', err);
      }
    }

    function onPresenceEvent() {
      refresh();
    }

    channel.presence.subscribe(onPresenceEvent);

    (async () => {
      try {
        if (online) {
          await channel.presence.enter();
        } else {
          try {
            await channel.presence.leave();
          } catch (_err) {
            /* not present, ignore */
          }
        }
        await refresh();
      } catch (err) {
        console.error('presence enter/leave error', err);
      }
    })();

    return () => {
      cancelled = true;
      channel.presence.unsubscribe(onPresenceEvent);
      if (online) {
        try {
          channel.presence.leave();
        } catch (_err) {
          /* no-op */
        }
      }
    };
  }, [client, online]);

  return members;
}
