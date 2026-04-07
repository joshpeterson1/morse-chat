// CW "cut numbers" — single-letter abbreviations operators use to shave
// dits off long digits at speed. The user only asked for the most common
// one (N for 9), so that's all we implement; the maps are defined as
// objects so adding T (0) or A (1) later is one line per direction.
//
// Internal canonical form is the digit string (e.g. "549"). We convert at
// the edges:
//   - Responder converts → cut form before keying the station reply
//   - SoloMode converts → cut form for display (dummy RST, summary card)
//   - Grader normalizes user input ← cut form back to digits before compare
//
// Keeping the canonical form internal means the stored state, the random
// generator, and the comparison logic all speak the same language; only
// the human-facing surfaces translate.

// Digit → cut letter (encode for sending / display).
const DIGIT_TO_CUT = {
  '9': 'N',
};

// Cut letter → digit (decode for grading user input).
const CUT_TO_DIGIT = {
  N: '9',
};

// Convert a canonical RST (or any digit string) to its cut form. Any digit
// that doesn't have a cut mapping passes through unchanged.
//   "549" → "54N"
//   "599" → "5NN"
//   "339" → "33N"
export function toCutNumbers(s) {
  if (typeof s !== 'string') return s;
  let out = '';
  for (const ch of s) {
    out += DIGIT_TO_CUT[ch] || ch;
  }
  return out;
}

// Convert a cut-form string back to canonical digits. Letters that don't
// have a mapping pass through unchanged so this is safe to run on user
// transmissions that mix forms ("5NN" or "599" both → "599").
export function fromCutNumbers(s) {
  if (typeof s !== 'string') return s;
  let out = '';
  for (const ch of s) {
    out += CUT_TO_DIGIT[ch] || ch;
  }
  return out;
}
