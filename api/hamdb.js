// Vercel serverless function: HamDB callsign lookup proxy.
//
// HamDB's CORS situation is unreliable from a browser, so this proxy is the
// only path the frontend uses. It also normalizes the response shape down to
// the only two fields the solo mode actually cares about (callsign + first
// name) so the client doesn't have to learn HamDB's JSON schema.
//
// Query: ?call=WB0RLJ
// Returns: { call: 'WB0RLJ', name: 'JIM' }   on hit
//          { call: 'WB0RLJ', name: null }    on miss / no fname

const CALL_RE = /^[A-Z0-9/]{3,16}$/;

export default async function handler(req, res) {
  const rawCall = String((req.query && req.query.call) || '').toUpperCase();
  const call = rawCall.replace(/[^A-Z0-9/]/g, '');

  if (!CALL_RE.test(call)) {
    res.status(400).json({ error: 'call must be 3-16 alphanumeric (slash allowed)' });
    return;
  }

  const upstream = `https://api.hamdb.org/${encodeURIComponent(call)}/json/morseChat`;

  try {
    const r = await fetch(upstream, {
      headers: { 'user-agent': 'morseChat-solo/0.1 (+hamdb proxy)' },
    });
    if (!r.ok) {
      res.status(502).json({ error: `upstream ${r.status}` });
      return;
    }
    const body = await r.json();

    // HamDB shape: { hamdb: { callsign: { call, fname, name, ... }, messages: { status: 'OK' | 'NOT_FOUND' } } }
    // Be defensive: any missing layer or a non-OK status collapses to a miss.
    const hamdb = body && body.hamdb;
    const status =
      (hamdb && hamdb.messages && hamdb.messages.status) || 'UNKNOWN';
    const cs = hamdb && hamdb.callsign;

    if (status !== 'OK' || !cs) {
      res.setHeader('cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400');
      res.status(200).json({ call, name: null, state: null });
      return;
    }

    // HamDB returns fname as the operator's first name and state as a
    // 2-letter US state abbreviation. Strip whitespace and anything that
    // isn't a printable letter — the WKUSB only sends ASCII.
    const rawName = String(cs.fname || '').trim();
    const cleanName = rawName.replace(/[^A-Za-z]/g, '').toUpperCase();
    const rawState = String(cs.state || '').trim();
    const cleanState = rawState.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2);

    res.setHeader('cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({
      call,
      name: cleanName || null,
      state: cleanState || null,
    });
  } catch (err) {
    console.error('hamdb proxy error', err);
    res.status(502).json({ error: 'upstream fetch failed' });
  }
}
