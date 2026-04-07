// Vercel serverless function: builds a complete CQ POTA solo session pool
// in a single request.
//
// Why this exists separately from /api/pota and /api/hamdb: the previous
// shape had the browser fanning out 2 + N requests through those proxies,
// which meant N+2 cold starts, N+2 TLS handshakes, and N+2 trips through
// Vercel's edge — all of which the user could feel as a multi-second wait
// before the first station even calls. By doing the whole orchestration
// inside a single function invocation, the browser pays one round trip
// and all the upstream fan-out happens server-side over warm connections.
//
// Algorithm (mirrors src/lib/cqpota/callPool.js, but server-side):
//   1. Shuffle the park list.
//   2. For each park in turn:
//      a. Fetch POTA leaderboard + activations in parallel.
//      b. Dedupe + normalize callsigns.
//      c. Hydrate up to MAX_HYDRATE of them with HamDB in parallel.
//      d. Drop misses; if >= MIN_VIABLE remain, return the pool.
//   3. If no park is viable, 503.
//
// Returns: { park, contacts: [{ call, name }, ...] }

// Same six refs as src/lib/cqpota/parks.js. Duplicated here to avoid the
// frontend / serverless module-resolution mess — six strings is cheap.
const PARKS = [
  'US-2226',
  'US-6412',
  'US-4566',
  'US-4567',
  'US-3791',
  'US-4556',
];

const MIN_VIABLE = 6;
const MAX_HYDRATE = 15;
const POTA_LB_COUNT = 20;
const POTA_ACT_COUNT = 50;

const UA = 'morseChat-solo/0.1 (+solo-pool)';

function normalizeCall(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9/]/g, '');
}

function extractCalls(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const c =
      row.callsign ||
      row.activeCallsign ||
      row.activator ||
      row.call ||
      null;
    if (typeof c === 'string' && c.length > 0) out.push(c);
  }
  return out;
}

async function fetchPotaCalls(parkRef) {
  const lbUrl = `https://api.pota.app/park/leaderboard/${encodeURIComponent(parkRef)}?count=${POTA_LB_COUNT}`;
  const actUrl = `https://api.pota.app/park/activations/${encodeURIComponent(parkRef)}?count=${POTA_ACT_COUNT}`;

  const [lbRes, actRes] = await Promise.all([
    fetch(lbUrl, { headers: { 'user-agent': UA } }),
    fetch(actUrl, { headers: { 'user-agent': UA } }),
  ]);

  // If both fail, that's a hard error; if only one fails we still try to
  // get a pool out of the survivor.
  const lb = lbRes.ok ? await lbRes.json() : null;
  const act = actRes.ok ? await actRes.json() : null;
  if (!lb && !act) return [];

  const merged = [...extractCalls(lb), ...extractCalls(act)]
    .map(normalizeCall)
    .filter((c) => c.length >= 3);

  // Dedupe preserving order: leaderboard entries come first.
  const seen = new Set();
  const out = [];
  for (const c of merged) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

async function hydrateOne(call) {
  const url = `https://api.hamdb.org/${encodeURIComponent(call)}/json/morseChat`;
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const body = await r.json();
    const hamdb = body && body.hamdb;
    const status = (hamdb && hamdb.messages && hamdb.messages.status) || 'UNKNOWN';
    if (status !== 'OK' || !hamdb.callsign) return null;
    const rawName = String(hamdb.callsign.fname || '').trim();
    const cleanName = rawName.replace(/[^A-Za-z]/g, '').toUpperCase();
    if (!cleanName) return null;
    // State comes back from HamDB as a 2-letter US state abbreviation
    // (e.g. "NE", "TX"). The responder keys it in the exchange reply as
    // "<state> <state>" — the doubling is the standard CW practice for
    // important fields. If the lookup didn't have a state, we leave it
    // null and the responder skips that part of the exchange.
    const rawState = String(hamdb.callsign.state || '').trim();
    const cleanState = rawState.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2);
    return {
      call,
      name: cleanName,
      state: cleanState || null,
    };
  } catch (_err) {
    return null;
  }
}

async function buildPoolForPark(parkRef) {
  const rawCalls = await fetchPotaCalls(parkRef);
  if (rawCalls.length === 0) return [];

  const slice = rawCalls.slice(0, MAX_HYDRATE);
  const hydrated = await Promise.all(slice.map((c) => hydrateOne(c)));
  return hydrated.filter(Boolean);
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default async function handler(req, res) {
  try {
    const order = shuffled(PARKS);

    for (const park of order) {
      const contacts = await buildPoolForPark(park);
      if (contacts.length >= MIN_VIABLE) {
        // Cache for a short window: the leaderboard + recents move slowly,
        // and the same physical user is unlikely to start two sessions
        // back-to-back. Edge cache helps when multiple users share the
        // same park selection.
        res.setHeader(
          'cache-control',
          'public, s-maxage=300, stale-while-revalidate=600'
        );
        res.status(200).json({
          park,
          contacts: shuffled(contacts),
        });
        return;
      }
    }

    res.status(503).json({
      error: 'No park yielded enough hydrated callsigns to start a session.',
    });
  } catch (err) {
    console.error('solo-pool error', err);
    res.status(500).json({ error: 'failed to build solo session pool' });
  }
}
