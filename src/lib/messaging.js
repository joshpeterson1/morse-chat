import { inboxChannelName } from './channels.js';

// Out-of-band signaling helpers. Each one publishes a single event to the
// recipient's personal inbox channel. The data payload always carries `from`
// (the sender's callsign) so the recipient can render UI without trusting
// only the Ably clientId on the message.

export function sendConnectionRequest(client, from, to) {
  return client.channels
    .get(inboxChannelName(to))
    .publish('connection-request', { from });
}

export function sendConnectionAccept(client, from, to) {
  return client.channels
    .get(inboxChannelName(to))
    .publish('connection-accept', { from });
}

export function sendConnectionDecline(client, from, to) {
  return client.channels
    .get(inboxChannelName(to))
    .publish('connection-decline', { from });
}
