// Vercel serverless function: issues an Ably TokenRequest signed with the
// server-side API key, scoped to the requested clientId (the user's callsign).
//
// The browser never sees ABLY_API_KEY — it only receives a short-lived token
// request that it uses to upgrade its Realtime connection.
//
// Set ABLY_API_KEY in your Vercel project env vars (and locally in .env for
// `vercel dev`).

import * as Ably from 'ably';

export default async function handler(req, res) {
  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ABLY_API_KEY not configured on server' });
    return;
  }

  const rawClientId =
    (req.query && req.query.clientId) ||
    (req.body && req.body.clientId) ||
    '';

  // Sanitize: callsigns are alphanumeric (with optional /) — strip everything
  // else and uppercase. Reject empty.
  const clientId = String(rawClientId)
    .toUpperCase()
    .replace(/[^A-Z0-9/]/g, '')
    .slice(0, 16);

  if (!clientId) {
    res.status(400).json({ error: 'clientId (callsign) is required' });
    return;
  }

  try {
    const rest = new Ably.Rest({ key: apiKey });
    const tokenRequest = await rest.auth.createTokenRequest({ clientId });
    res.status(200).json(tokenRequest);
  } catch (err) {
    console.error('ably-token error', err);
    res.status(500).json({ error: 'failed to create token request' });
  }
}
