import { fromCutNumbers } from './cutNumbers.js';

// Scores a single completed CQ POTA QSO.
//
// Inputs:
//   contact:        { call, name }      — the station the user worked
//   dummyRst:       string              — the RST the user was supposed to send
//   exchangeParse:  parsed transmission — the user's call+RST exchange
//   closeParse:     parsed transmission — the user's closing transmission
//   userCallsign:   string              — the user's own callsign (for closer grading)
//
// Output: { total, breakdown: [{ label, points, max, note? }], multiplier }
//
// Weighting: callsign accuracy is the dominant grade. Everything else is
// either a small bonus or a multiplier (`FB`).

const MAX_CALL_POINTS = 50;
const MAX_RST_POINTS = 20;
const NAME_BONUS = 10;
const GREETING_BONUS = 5;
const TU_BONUS = 1;
const SEVENTY_THREE_BONUS = 1;
const CLOSER_CALL_BONUS = 5;
const FB_PER = 0.1;     // each FB adds +10% to the final score
const FB_CAP = 2.0;     // max multiplier 2.0x (so user can double their score)

// Levenshtein distance, capped — we only care about distances 0..3 for
// scoring purposes, so bail out early on anything bigger.
function editDistance(a, b, cap = 4) {
  if (a === b) return 0;
  if (!a || !b) return Math.min(cap, Math.max((a || '').length, (b || '').length));
  if (Math.abs(a.length - b.length) > cap) return cap;

  const m = a.length;
  const n = b.length;
  // Two-row DP, since we don't need the full matrix.
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin >= cap) return cap;
    [prev, curr] = [curr, prev];
  }
  return Math.min(cap, prev[n]);
}

// Pick the best of N candidate strings against an expected value: an exact
// match always wins; otherwise the lowest edit-distance candidate wins.
// Returns { best, dist } or { best: null, dist: Infinity } when no
// candidates were supplied. Used for both call and RST since the user can
// send either of them in any order (or even before their own call).
function pickClosest(candidates, expected) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { best: null, dist: Infinity };
  }
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (c === expected) return { best: c, dist: 0 };
    const d = editDistance(c, expected);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return { best, dist: bestDist };
}

function scoreCall(parsed, expected) {
  const candidates = (parsed && parsed.callAttempts) || [];
  if (candidates.length === 0) return { points: 0, attempt: null, note: 'no callsign sent' };
  const { best, dist } = pickClosest(candidates, expected);
  if (dist === 0) return { points: MAX_CALL_POINTS, attempt: best, note: 'exact' };
  if (dist === 1) return { points: Math.round(MAX_CALL_POINTS * 0.5), attempt: best, note: '1 char off' };
  if (dist === 2) return { points: Math.round(MAX_CALL_POINTS * 0.2), attempt: best, note: '2 chars off' };
  return { points: 0, attempt: best, note: 'wrong call' };
}

function scoreRst(parsed, expected) {
  const candidates = (parsed && parsed.rstAttempts) || [];
  if (candidates.length === 0) return { points: 0, attempt: null, note: 'no RST sent' };
  // Normalize cut numbers (N → 9) on both sides so "5NN" / "599" / "5N9"
  // all grade as identical. The expected value is already canonical.
  const normalized = candidates.map((c) => fromCutNumbers(c));
  const { best, dist } = pickClosest(normalized, expected);
  if (dist === 0) return { points: MAX_RST_POINTS, attempt: best, note: 'exact' };
  // RST is only 3 chars; off-by-one is half credit, anything else nothing.
  if (dist === 1) return { points: Math.round(MAX_RST_POINTS * 0.5), attempt: best, note: '1 digit off' };
  return { points: 0, attempt: best, note: 'wrong RST' };
}

// Name match is strict at the token level, but also accepts the expected
// name appearing as a substring inside any run-together exchange token —
// e.g. "TUBRIANUR429" credits "BRIAN". Run-together tokens are filtered
// upstream to only include mixed alphanumeric data, so a pure name token
// like ARTHUR can't false-positive on a different expected name.
function nameMatches(parsed, expected) {
  if (!parsed || !expected) return false;
  if (parsed.nameAttempt === expected) return true;
  if (Array.isArray(parsed.runTogetherTokens)) {
    for (const t of parsed.runTogetherTokens) {
      if (t.includes(expected)) return true;
    }
  }
  return false;
}

// Did the user's closing transmission contain their own call somewhere?
// (Per the spec: doesn't have to be the last token, just present.)
function closerHasCall(closeParse, userCallsign) {
  if (!closeParse || !userCallsign) return false;
  return closeParse.tokens.includes(userCallsign);
}

export function gradeQso({
  contact,
  dummyRst,
  exchangeParse,
  closeParse,
  userCallsign,
  expectedGreeting: expectedGreetingValue,
}) {
  const breakdown = [];

  // Callsign accuracy (heavy)
  const callResult = scoreCall(exchangeParse, contact.call);
  breakdown.push({
    label: 'Callsign',
    points: callResult.points,
    max: MAX_CALL_POINTS,
    note: callResult.note,
  });

  // RST accuracy
  const rstResult = scoreRst(exchangeParse, dummyRst);
  breakdown.push({
    label: 'RST',
    points: rstResult.points,
    max: MAX_RST_POINTS,
    note: rstResult.note,
  });

  // Name bonus
  const nameOk = nameMatches(exchangeParse, contact.name);
  breakdown.push({
    label: 'Name',
    points: nameOk ? NAME_BONUS : 0,
    max: NAME_BONUS,
    note: nameOk ? `correct (${contact.name})` : `expected ${contact.name}`,
  });

  // Greeting bonus
  const greetOk = exchangeParse?.greeting === expectedGreetingValue;
  breakdown.push({
    label: 'Greeting',
    points: greetOk ? GREETING_BONUS : 0,
    max: GREETING_BONUS,
    note: greetOk ? `correct (${expectedGreetingValue})` : `expected ${expectedGreetingValue}`,
  });

  // Closer: TU
  const tuOk = !!closeParse?.hasTU || !!exchangeParse?.hasTU;
  breakdown.push({
    label: 'Closer: TU',
    points: tuOk ? TU_BONUS : 0,
    max: TU_BONUS,
  });

  // Closer: 73
  const seventyThreeOk = !!closeParse?.has73;
  breakdown.push({
    label: 'Closer: 73',
    points: seventyThreeOk ? SEVENTY_THREE_BONUS : 0,
    max: SEVENTY_THREE_BONUS,
  });

  // Closing with own call
  const callerOk = closerHasCall(closeParse, userCallsign);
  breakdown.push({
    label: 'Signed own call',
    points: callerOk ? CLOSER_CALL_BONUS : 0,
    max: CLOSER_CALL_BONUS,
  });

  const subtotal = breakdown.reduce((acc, b) => acc + b.points, 0);

  // FB multiplier — count FBs across BOTH the exchange AND the closer.
  const fbCount =
    (exchangeParse?.fbCount || 0) + (closeParse?.fbCount || 0);
  const multiplier = Math.min(FB_CAP, 1 + FB_PER * fbCount);

  const total = Math.round(subtotal * multiplier);

  return {
    total,
    subtotal,
    multiplier,
    fbCount,
    breakdown,
  };
}
