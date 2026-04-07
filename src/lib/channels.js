// Channel name conventions for Morse Chat.
//
// - LOBBY_CHANNEL: a single shared presence channel. Anyone who toggles
//   "appear online" enters this channel; the member list IS the user list.
// - inboxChannelName(callsign): one channel per user. Other users publish
//   connection-request / connection-accept / connection-decline events here
//   to talk *to* that user out-of-band of any pair session.
// - pairChannelName(a, b): the channel two paired users use to exchange
//   morse-text and disconnect events. Sorted so both sides resolve to the
//   same name regardless of who initiated.

export const LOBBY_CHANNEL = 'morse:lobby';

export function inboxChannelName(callsign) {
  return `morse:inbox:${callsign}`;
}

export function pairChannelName(a, b) {
  return `morse:pair:${[a, b].sort().join('|')}`;
}
