// Pure decision function for the solo CQ POTA QSO state machine.
//
// The hook calls decide() each time a user transmission is parsed; this
// module returns what the calling station should do next and which phase
// the QSO is in afterwards. No side effects — the hook is responsible for
// keying the wkusb, updating React state, and storing the parsed exchange
// for later grading.
//
// Phases:
//   'await_user'   — station has called CQ (or already replied to a partial
//                    request); waiting for the user to either ask for a
//                    repeat, confirm the call, or give the full exchange.
//   'await_close'  — station has sent its exchange reply; waiting for the
//                    user's closing transmission so we can grade.
//   'done'         — QSO is complete and graded.
//
// Actions returned:
//   'silent'           — ignore this transmission, stay in the same phase
//   'repeat_call'      — re-key the contact's call (response to a matching
//                        partial-call request)
//   'confirm'          — key "RR <call>" (response to a full-call ?)
//   'exchange'         — key the exchange reply, advance to await_close
//   'repeat_exchange'  — re-key the exchange reply (response to a `?` after
//                        we've already replied)
//   'close'            — grade the QSO and advance to done
//
// The 'context' for the decision is the parsed user transmission plus the
// contact we're working — both of which the hook already has on hand.

import { partialMatchesCall } from './parser.js';

// Did the user's transmission contain a usable exchange (callsign + RST)?
// If so, we go straight to await_close regardless of whether they prefixed
// it with `?` style confirms first. We accept ANY call attempt and ANY
// RST attempt — the grader picks the best ones against the expected
// values, so we don't need to be selective here.
function hasExchange(parsed) {
  if (!parsed) return false;
  const hasCall = Array.isArray(parsed.callAttempts) && parsed.callAttempts.length > 0;
  const hasRst = Array.isArray(parsed.rstAttempts) && parsed.rstAttempts.length > 0;
  return hasCall && hasRst;
}

// Did the user's transmission look like a full-call confirmation? Shape:
//   last token is `<call>?` AND that <call> equals our contact's call.
function isFullCallConfirm(parsed, contactCall) {
  if (!parsed || !parsed.partialReq) return false;
  if (parsed.partialReq.kind !== 'partial') return false;
  return parsed.partialReq.letters === contactCall;
}

export function decide({ phase, parsed, contact }) {
  const contactCall = contact.call;

  if (phase === 'await_user') {
    // Exchange shortcut — they sent the goods, take it.
    if (hasExchange(parsed)) {
      return { action: 'exchange', nextPhase: 'await_close' };
    }

    // Full-call confirm → "RR <call>", stay waiting for the actual exchange.
    if (isFullCallConfirm(parsed, contactCall)) {
      return { action: 'confirm', nextPhase: 'await_user' };
    }

    // Partial / bare / QRZ request → repeat or stay silent per etiquette.
    if (parsed && parsed.partialReq) {
      const { kind, letters } = parsed.partialReq;
      if (kind === 'full' || kind === 'qrz') {
        return { action: 'repeat_call', nextPhase: 'await_user' };
      }
      // kind === 'partial'
      if (partialMatchesCall(letters, contactCall)) {
        return { action: 'repeat_call', nextPhase: 'await_user' };
      }
      // No match — silent, per real CW etiquette: the calling station
      // doesn't repeat for fragments that aren't theirs.
      return { action: 'silent', nextPhase: 'await_user' };
    }

    // Random chatter that's neither a request nor a complete exchange.
    // Stay silent and let the user try again.
    return { action: 'silent', nextPhase: 'await_user' };
  }

  if (phase === 'await_close') {
    // After we've sent our exchange reply, a `?` is "say again" for the
    // exchange — re-key it. Anything else counts as the user's closing
    // transmission and the QSO ends.
    if (parsed && parsed.partialReq) {
      return { action: 'repeat_exchange', nextPhase: 'await_close' };
    }
    return { action: 'close', nextPhase: 'done' };
  }

  // phase === 'done' or unknown — stay put.
  return { action: 'silent', nextPhase: phase };
}
