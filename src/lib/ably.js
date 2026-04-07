import * as Ably from 'ably';

// Creates a Realtime client that authenticates by calling our serverless
// token endpoint. The browser never holds the API key — only short-lived
// tokens scoped to the callsign.
//
// echoMessages: false means we don't receive our own publishes back; UI
// components add a local echo when they send so the user sees their own
// messages immediately.
export function createAblyClient(callsign) {
  return new Ably.Realtime({
    authUrl: `/api/ably-token?clientId=${encodeURIComponent(callsign)}`,
    echoMessages: false,
  });
}
