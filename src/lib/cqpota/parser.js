// Parses a single user transmission (the chunk of input between two
// "I'm done" boundaries) and pulls out the structured fields the QSO
// machine and grader care about.
//
// A transmission is whatever the hook buffered up before the boundary
// fired. Boundaries are detected upstream by the hook (BK token, trailing
// `?`, or input timeout) — this module just receives the text.
//
// The output is intentionally flat: callers pick the fields they need and
// the grader compares them against the expected contact data.

// Words that are protocol noise, NOT operator names. Used to filter when
// guessing which token is the user's attempt at the contact's name.
const RESERVED = new Set([
  'BK', 'TU', 'RR', 'FB', 'ES', 'UR', 'DE', 'NE',
  'GA', 'GE', 'GM', 'QRZ', 'AGN', 'OM', '73', '88',
  'CQ', 'POTA', 'PSE', 'AGN?', 'AGN.', 'K',
]);

// Looks like a callsign: 1-2 letters, optional digit(s), 1-4 letters,
// optional /portable suffix. Permissive to allow user typos to still
// "look like a call" so the grader can score them by edit distance.
const CALL_RE = /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{1,4}(?:\/[A-Z0-9]+)?$/;

// RST in the form Rsl-tone, where:
//   R (readability)    — 1..5
//   S (signal strength)— 1..9 OR cut "N" for 9
//   T (tone)           — 9 OR cut "N" for 9 (always 9 for CW in practice)
// This accepts both digit form ("549", "599") and cut-number form
// ("54N", "5NN", "5N9"). The grader normalizes via fromCutNumbers() before
// edit-distance comparison so the two forms grade as equal.
const RST_RE = /^[1-5][1-9N][9N]$/;

// Same RST shape but used for scanning the raw upper text — un-anchored so
// it pulls "429" / "42N" out of "TUBRIANUR429" when an op runs words
// together. The 9 → N substitution is part of the pattern so smushed
// cut-form RSTs are also recovered.
const RST_SCAN_RE = /[1-5][1-9N][9N]/g;

function tokenize(raw) {
  return String(raw || '')
    .toUpperCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// Parse a transmission. Returns:
//   {
//     raw, upper, tokens,
//     partialReq:    null | { kind: 'full' | 'partial' | 'qrz', letters: '' },
//     callAttempts:  string[]    every call-shaped token (the grader picks)
//     rstAttempts:   string[]    every [1-5][1-5]9 substring in the raw text
//     nameAttempt:   null | string   best heuristic guess from clean tokens
//     greeting:      null | 'GM' | 'GA' | 'GE',
//     fbCount:       integer >= 0,
//     hasTU:         bool,
//     has73:         bool,
//     hasBK:         bool,
//   }
//
// Why arrays for call/RST: real CW spacing is fluid. An op might run
// "TUBRIANUR429" together, or send their own call before the contact's
// call. Returning every candidate lets the grader pick whichever matches
// the expected value, instead of guessing an order at parse time.
export function parseTransmission(raw) {
  const upper = String(raw || '').toUpperCase();
  const tokens = tokenize(upper);

  // ── Partial-call request detection ────────────────────────────────────
  // Etiquette uses a trailing `?` on a callsign fragment to ask the
  // station to repeat. The shapes we recognize:
  //   '?'         → bare repeat request
  //   'AGN?'      → same
  //   'QRZ?'      → same (prompt for any caller, treat as repeat)
  //   'WB0?'      → partial fragment + ?
  //   'WB0RLJ?'   → full call + ? (used for confirmation)
  //
  // We look at the LAST token only — if it ends with `?`, that's the
  // request. Anything before it is likely earlier chatter we ignore for
  // request handling (the exchange path uses different fields).
  let partialReq = null;
  const last = tokens[tokens.length - 1];
  if (last && last.endsWith('?')) {
    const stripped = last.slice(0, -1);
    if (stripped === '' || stripped === 'AGN') {
      partialReq = { kind: 'full', letters: '' };
    } else if (stripped === 'QRZ') {
      partialReq = { kind: 'qrz', letters: '' };
    } else if (/^[A-Z0-9]+$/.test(stripped)) {
      partialReq = { kind: 'partial', letters: stripped };
    }
  }

  // ── Callsign attempts ─────────────────────────────────────────────────
  // Every clean token (not a `?` request) that looks like a callsign.
  // Order is preserved so the grader can break ties by "first sent".
  const callAttempts = [];
  for (const t of tokens) {
    if (t.endsWith('?')) continue;
    if (CALL_RE.test(t)) callAttempts.push(t);
  }

  // ── RST attempts ──────────────────────────────────────────────────────
  // Scan the raw upper text — not just clean tokens — so we catch RSTs
  // smushed inside run-together words like "TUBRIANUR429". Doubles
  // ("599 599") collapse via dedupe.
  const rstAttempts = [];
  const seenRst = new Set();
  for (const m of upper.matchAll(RST_SCAN_RE)) {
    const v = m[0];
    if (seenRst.has(v)) continue;
    seenRst.add(v);
    rstAttempts.push(v);
  }

  // ── Run-together exchange tokens ──────────────────────────────────────
  // Tokens that mix letters AND digits but aren't a clean call or RST are
  // almost always smushed exchange data (e.g. "TUBRIANUR429"). Pure-letter
  // tokens are names or protocol words; we leave those alone so we don't
  // false-positive on a name like ARTHUR containing "TU". The grader uses
  // this list to do substring fallbacks for the name and to find protocol
  // markers (TU, BK, 73, FB) that are buried inside the smush.
  const runTogetherTokens = tokens.filter((t) => {
    if (t.endsWith('?')) return false;
    if (CALL_RE.test(t)) return false;
    if (RST_RE.test(t)) return false;
    return /[A-Z]/.test(t) && /[0-9]/.test(t);
  });

  // ── Name attempt (heuristic, strict token path) ───────────────────────
  // First all-letters token that isn't reserved noise and isn't a callsign.
  // Works for clean input like "TU JIM"; the grader has a substring
  // fallback against the expected name for run-together inputs.
  let nameAttempt = null;
  for (const t of tokens) {
    if (t.endsWith('?')) continue;
    if (RESERVED.has(t)) continue;
    if (!/^[A-Z]+$/.test(t)) continue;
    if (CALL_RE.test(t)) continue;
    nameAttempt = t;
    break;
  }

  // ── Greeting ──────────────────────────────────────────────────────────
  // Token-based detection only — GM/GA/GE are too easy to false-positive
  // on names (GEORGE, GABRIEL) or protocol slurs (AGN) if we substring it.
  let greeting = null;
  if (tokens.includes('GM')) greeting = 'GM';
  else if (tokens.includes('GA')) greeting = 'GA';
  else if (tokens.includes('GE')) greeting = 'GE';

  // ── Protocol markers (TU / BK / 73 / FB) ──────────────────────────────
  // Token-level first, then look inside run-together tokens for the same
  // markers. This catches "TUBRIANUR429" → TU + UR but won't trip on a
  // pure-letter name like ARTHUR (filtered out of runTogetherTokens above).
  let hasTU = tokens.includes('TU');
  let hasBK = tokens.includes('BK');
  let has73 = tokens.includes('73');
  let fbCount = 0;
  for (const t of tokens) {
    if (t === 'FB') fbCount += 1;
  }
  for (const t of runTogetherTokens) {
    if (!hasTU && t.includes('TU')) hasTU = true;
    if (!hasBK && t.includes('BK')) hasBK = true;
    if (!has73 && t.includes('73')) has73 = true;
    const fbInside = t.match(/FB/g);
    if (fbInside) fbCount += fbInside.length;
  }

  return {
    raw,
    upper,
    tokens,
    runTogetherTokens,
    partialReq,
    callAttempts,
    rstAttempts,
    nameAttempt,
    greeting,
    fbCount,
    hasTU,
    has73,
    hasBK,
  };
}

// Map the user's local clock to a CW greeting. The cutoffs match the rough
// "morning until noon, afternoon until early evening, evening after that"
// convention most ops use on the air.
export function expectedGreeting(date = new Date()) {
  const h = date.getHours();
  if (h < 12) return 'GM';
  if (h < 18) return 'GA';
  return 'GE';
}

// Substring match used by the partial-call etiquette. The station should
// only repeat if the requested fragment appears anywhere in its own call —
// otherwise it stays silent and lets the next caller try.
export function partialMatchesCall(letters, ourCall) {
  if (!letters) return false;
  return ourCall.includes(letters);
}
