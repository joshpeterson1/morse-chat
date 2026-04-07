// Vercel serverless function: thin proxy in front of api.pota.app.
//
// Why proxy at all when POTA's CORS is currently permissive: their headers
// could change at any time, and going through us also lets us cap the
// response size, validate inputs, and add caching headers without depending
// on the upstream's cooperation.
//
// Query params:
//   ?park=US-4556       (required, US-#### shape)
//   &kind=leaderboard   (or "activations" — defaults to leaderboard)
//   &count=50           (optional, 1..100, defaults to 50)
//
// Returns the upstream JSON body verbatim. Errors come back as
// { error: '...' } with a non-200 status.

const PARK_RE = /^[A-Z]{1,4}-\d{2,6}$/;
const ALLOWED_KINDS = new Set(['leaderboard', 'activations']);

export default async function handler(req, res) {
  const park = String((req.query && req.query.park) || '').toUpperCase();
  const kindRaw = String((req.query && req.query.kind) || 'leaderboard').toLowerCase();
  const countRaw = Number((req.query && req.query.count) || 50);

  if (!PARK_RE.test(park)) {
    res.status(400).json({ error: 'park must look like US-4556' });
    return;
  }
  if (!ALLOWED_KINDS.has(kindRaw)) {
    res.status(400).json({ error: 'kind must be leaderboard or activations' });
    return;
  }
  const count = Math.max(1, Math.min(100, Math.floor(countRaw) || 50));

  const upstream = `https://api.pota.app/park/${kindRaw}/${encodeURIComponent(park)}?count=${count}`;

  try {
    const r = await fetch(upstream, {
      headers: { 'user-agent': 'morseChat-solo/0.1 (+pota proxy)' },
    });
    if (!r.ok) {
      res.status(502).json({ error: `upstream ${r.status}`, upstream });
      return;
    }
    const body = await r.json();
    // Cache for a few minutes — leaderboards & recent activations don't move
    // fast, and a session only ever pulls these once anyway.
    res.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=600');
    res.status(200).json(body);
  } catch (err) {
    console.error('pota proxy error', err);
    res.status(502).json({ error: 'upstream fetch failed' });
  }
}
