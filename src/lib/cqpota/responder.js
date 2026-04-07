// Builds the calling station's transmissions for the solo CQ POTA mode.
//
// Output format: an array of "parts" suitable for wkusb.sendMessage —
// strings get keyed as plain text, `{ prosign: 'BK' }` objects get keyed
// as a Merge Letters prosign (0x1B B K).
//
// The 5% prosign-BK rule the user asked for is implemented here: each time
// we'd send a `BK`, we roll once. If it lands, we swap that BK for a merged
// prosign — technically incorrect (BK isn't a real prosign) but a thing
// real ops do for flavor.
//
// RST is keyed in cut-number form by default ("54N" instead of "549") —
// that's how POTA/contest ops actually send it on the air. The hook stores
// canonical digit form internally; we convert here at the wire boundary.

import { toCutNumbers } from './cutNumbers.js';

const PROSIGN_BK_PROBABILITY = 0.05;

function bkPart() {
  if (Math.random() < PROSIGN_BK_PROBABILITY) {
    return { prosign: 'BK' };
  }
  return 'BK';
}

// Initial CQ call: just the contact's callsign. Sent once when the QSO
// starts. The user hears this on the keyer's sidetone and is expected to
// respond.
export function buildInitialCall(contactCall) {
  return [`${contactCall} `];
}

// Repeat the call after a partial-match request like "W?" or "WB0?". Same
// content as the initial call — just the call by itself.
export function buildCallRepeat(contactCall) {
  return [`${contactCall} `];
}

// Acknowledge a full-call confirmation ("WB0RLJ?") with "RR <call>".
export function buildConfirm(contactCall) {
  return [`RR ${contactCall} `];
}

// The big exchange reply, sent after the user gives the contact their RST.
// Pattern: "BK FB ES TU <USER_NAME> UR <RST> <RST> <STATE> <STATE> BK"
//
// - userName may be null if HamDB had no hit on the user's own call —
//   in that case we drop the "TU <name>" piece.
// - contactState is the calling station's HamDB state (2-letter US abbr).
//   If null/missing we drop the "<state> <state>" piece entirely rather
//   than fabricating one — better to say less than to lie about location.
//
// replyRst comes in as canonical digits (e.g. "549") and is converted to
// cut form ("54N") before keying.
export function buildExchangeReply(userName, replyRst, contactState) {
  const cutRst = toCutNumbers(replyRst || '');
  const parts = [];
  parts.push(bkPart());
  parts.push(' FB ES TU');
  if (userName) {
    parts.push(` ${userName}`);
  }
  parts.push(` UR ${cutRst} ${cutRst}`);
  if (contactState) {
    parts.push(` ${contactState} ${contactState}`);
  }
  parts.push(' ');
  parts.push(bkPart());
  return parts;
}
