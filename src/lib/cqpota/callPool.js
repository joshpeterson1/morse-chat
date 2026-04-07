// Builds a queue of "calling station" contacts for a single Solo session.
//
// All the heavy lifting (POTA fan-out, HamDB hydration, park rotation) now
// happens server-side in api/solo-pool.js so the browser only pays one
// round trip. The proxies at /api/pota and /api/hamdb still exist for
// other lookups (e.g. the user's own callsign in useSoloQso) but the pool
// build does not use them.

// Public entry point. Returns { park, contacts: [{ call, name }, ...] }
// once a viable park is found, or throws on error.
export async function buildSessionPool() {
  const r = await fetch('/api/solo-pool');
  if (!r.ok) {
    let detail = '';
    try {
      const body = await r.json();
      detail = body && body.error ? `: ${body.error}` : '';
    } catch (_err) {
      /* no body */
    }
    throw new Error(`solo-pool ${r.status}${detail}`);
  }
  return r.json();
}

// Roll a random RST in the form xy9 with x,y in 1..5. Used both for the
// "dummy RST" the user is asked to send to the station AND for the
// station's reply RST.
export function randomRst() {
  const x = 1 + Math.floor(Math.random() * 5);
  const y = 1 + Math.floor(Math.random() * 5);
  return `${x}${y}9`;
}
