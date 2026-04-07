import { useCallback, useEffect, useRef, useState } from 'react';
import {
  sendMessage as wkusbSendMessage,
  onChar as wkusbOnChar,
  isConnected as wkusbIsConnected,
  whenIdle as wkusbWhenIdle,
} from '../lib/wkusb.js';
import { buildSessionPool, randomRst } from '../lib/cqpota/callPool.js';
import { parseTransmission, expectedGreeting } from '../lib/cqpota/parser.js';
import { decide } from '../lib/cqpota/qsoMachine.js';
import {
  buildInitialCall,
  buildCallRepeat,
  buildConfirm,
  buildExchangeReply,
} from '../lib/cqpota/responder.js';
import { gradeQso } from '../lib/cqpota/grader.js';

// Solo CQ POTA orchestrator.
//
// Holds the QSO state machine, the buffered user transmission, the working
// log, and the running session score. Listens to wkusb paddle echo for
// inbound characters AND exposes feedChar() so the SoloMode component can
// pipe its keyboard <input> through the same path. Both sources funnel into
// the same transmission buffer; boundaries flush the buffer through the
// parser → machine → action pipeline.
//
// "Transmission boundary" means the user has handed it back. Triggers:
//   - a `?` arrives                          (a request shape — handled at once)
//   - a whitespace arrives after a `BK` token (explicit "back to you")
//   - 1.5s of input silence                  (timeout fallback)
//
// The hook only runs while `active` is true. Toggling active off cleans up
// the timer and the wkusb listener.

const QUIET_TIMEOUT_MS = 1500;
const USER_NAME_KEY = 'morseChat.solo.userName';
const SESSION_SCORE_KEY = 'morseChat.solo.sessionScore';

// localStorage helpers — both the user's looked-up name and the running
// session score persist across page reloads. The score reset is exposed via
// the `endSession()` action so users can start fresh.
function readCachedUserName(callsign) {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(USER_NAME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.call === callsign && parsed.name) return parsed.name;
    return null;
  } catch (_err) {
    return null;
  }
}

function writeCachedUserName(callsign, name) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(USER_NAME_KEY, JSON.stringify({ call: callsign, name }));
  } catch (_err) {
    /* no-op */
  }
}

function readCachedScore() {
  try {
    if (typeof window === 'undefined') return 0;
    const raw = window.localStorage.getItem(SESSION_SCORE_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (_err) {
    return 0;
  }
}

function writeCachedScore(score) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SESSION_SCORE_KEY, String(score));
  } catch (_err) {
    /* no-op */
  }
}

async function lookupUserName(callsign) {
  if (!callsign) return null;
  const cached = readCachedUserName(callsign);
  if (cached) return cached;
  try {
    const r = await fetch(`/api/hamdb?call=${encodeURIComponent(callsign)}`);
    if (!r.ok) return null;
    const body = await r.json();
    const name = body && body.name ? body.name : null;
    if (name) writeCachedUserName(callsign, name);
    return name;
  } catch (_err) {
    return null;
  }
}

export function useSoloQso({ active, userCallsign }) {
  // ── Public state ─────────────────────────────────────────────────────
  const [status, setStatus] = useState('idle'); // idle | loading | running | error | empty
  const [park, setPark] = useState(null);
  const [userName, setUserName] = useState(null);

  const [phase, setPhase] = useState('idle');
  const [currentContact, setCurrentContact] = useState(null);
  const [currentDummyRst, setCurrentDummyRst] = useState(null);
  const [currentReplyRst, setCurrentReplyRst] = useState(null);
  const [callKeyedCorrectly, setCallKeyedCorrectly] = useState(false);

  const [logEntries, setLogEntries] = useState([]); // completed QSOs (table rows)
  const [transcript, setTranscript] = useState([]); // chat-style stream for the active QSO
  const [sessionScore, setSessionScore] = useState(() => readCachedScore());
  const [lastQsoResult, setLastQsoResult] = useState(null);
  const [error, setError] = useState(null);

  // ── Mutable refs (don't trigger re-render) ───────────────────────────
  const bufferRef = useRef('');
  const timerRef = useRef(null);
  const poolRef = useRef([]);
  const phaseRef = useRef('idle');
  const contactRef = useRef(null);
  const dummyRstRef = useRef(null);
  const replyRstRef = useRef(null);
  const exchangeParseRef = useRef(null);
  const userNameRef = useRef(null);
  // Idempotency guard for startSession. React 18 StrictMode fires mount
  // effects twice in dev, which would otherwise call startSession() twice
  // — fetching two pools, shifting two contacts, and writing two
  // different callsigns to the keyer back-to-back before the user does
  // anything. The ref survives both legs of StrictMode's mount cycle so
  // the second call is a clean no-op.
  const sessionStartedRef = useRef(false);

  // Mirror reactive state into refs so the (event-driven) ingest path can
  // read the latest values without forcing re-renders or stale closures.
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { contactRef.current = currentContact; }, [currentContact]);
  useEffect(() => { dummyRstRef.current = currentDummyRst; }, [currentDummyRst]);
  useEffect(() => { replyRstRef.current = currentReplyRst; }, [currentReplyRst]);
  useEffect(() => { userNameRef.current = userName; }, [userName]);

  const appendTranscript = useCallback((from, text) => {
    setTranscript((prev) => [...prev, { from, text, t: Date.now() }]);
  }, []);

  // ── Wire-level send: routes a parts array through wkusb AND mirrors it
  // into the transcript so the user can SEE what the station just keyed.
  //
  // CRITICAL: we MUST wait for the device to be idle before writing.
  // Software cannot break in on the operator — when the user is keying
  // on the paddle (e.g. sending `?` to request a repeat), the K1EL takes
  // paddle input as priority and clears its serial input buffer per the
  // spec (data.pdf p.3). Anything we write while they're paddling gets
  // dropped or partially processed. Waiting for the busy flag to clear
  // (which transitions to idle when both paddle and serial keying are
  // done) gives us a safe window to slot the station's response.
  const stationSend = useCallback(async (parts, displayText) => {
    if (wkusbIsConnected()) {
      await wkusbWhenIdle();
      wkusbSendMessage(parts);
    }
    appendTranscript('them', displayText);
  }, [appendTranscript]);

  // Renders a parts array into a human-readable string for the transcript
  // (prosigns become <BK>, plain strings pass through). Doesn't touch the
  // wire bytes — wkusb.sendMessage handles those.
  const renderParts = useCallback((parts) => {
    return parts
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && p.prosign) return `<${p.prosign}>`;
        return '';
      })
      .join('');
  }, []);

  // ── Start the next QSO from the pool ─────────────────────────────────
  const startNextQso = useCallback(() => {
    const next = poolRef.current.shift();
    if (!next) {
      setStatus('empty');
      setPhase('idle');
      phaseRef.current = 'idle';
      return;
    }
    const dummy = randomRst();
    const reply = randomRst();
    setCurrentContact(next);
    setCurrentDummyRst(dummy);
    setCurrentReplyRst(reply);
    setCallKeyedCorrectly(false);
    contactRef.current = next;
    dummyRstRef.current = dummy;
    replyRstRef.current = reply;
    exchangeParseRef.current = null;
    bufferRef.current = '';

    // Reset transcript per QSO so the active panel only ever shows the
    // current contact's exchange. Completed QSOs live in logEntries.
    setTranscript([]);

    setPhase('await_user');
    phaseRef.current = 'await_user';

    // Key the initial CQ call response. Tiny defer so the React state has
    // settled and the user sees the new contact's name + dummy RST before
    // the keyer starts clattering.
    setTimeout(() => {
      const parts = buildInitialCall(next.call);
      stationSend(parts, renderParts(parts));
    }, 200);
  }, [stationSend, renderParts]);

  // ── Grade and finish a QSO ───────────────────────────────────────────
  const finishQso = useCallback((closeParse) => {
    const contact = contactRef.current;
    const dummy = dummyRstRef.current;
    const reply = replyRstRef.current;
    const exchange = exchangeParseRef.current;
    if (!contact) return;

    const result = gradeQso({
      contact,
      dummyRst: dummy,
      exchangeParse: exchange,
      closeParse,
      userCallsign,
      expectedGreeting: expectedGreeting(),
    });

    setLastQsoResult({ contact, dummyRst: dummy, replyRst: reply, ...result });
    setSessionScore((prev) => {
      const next = prev + result.total;
      writeCachedScore(next);
      return next;
    });
    // For the working-log "Call" cell: if the user keyed the contact's
    // call exactly somewhere in their exchange, show it. Otherwise show
    // their first call attempt so the table can display what they actually
    // sent (even if wrong).
    const exchangeCalls = (exchange && exchange.callAttempts) || [];
    const loggedCall =
      exchangeCalls.find((c) => c === contact.call) ||
      exchangeCalls[0] ||
      null;

    setLogEntries((prev) => [
      ...prev,
      {
        contact,
        dummyRst: dummy,
        replyRst: reply,
        keyedCall: loggedCall,
        score: result.total,
      },
    ]);

    setPhase('done');
    phaseRef.current = 'done';

    // Auto-roll into the next QSO after a short pause so the user can
    // glance at the summary card before the next station calls.
    setTimeout(() => {
      startNextQso();
    }, 2500);
  }, [userCallsign, startNextQso]);

  // ── Buffer flush: parse, decide, act ─────────────────────────────────
  const flushBuffer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const raw = bufferRef.current.trim();
    bufferRef.current = '';
    if (!raw) return;

    appendTranscript('me', raw);

    const parsed = parseTransmission(raw);
    const contact = contactRef.current;
    if (!contact) return;

    const { action, nextPhase } = decide({
      phase: phaseRef.current,
      parsed,
      contact,
    });

    // Track whether the user has keyed the call exactly right at any point
    // — used to fill in the working-log "Callsign" cell. Accept a hit on
    // any of the parsed candidates so a "<own> <contact>" order still
    // counts.
    if (parsed.callAttempts && parsed.callAttempts.includes(contact.call)) {
      setCallKeyedCorrectly(true);
    }

    switch (action) {
      case 'silent':
        // Nothing on the wire; we just absorb the transmission.
        break;

      case 'repeat_call': {
        const parts = buildCallRepeat(contact.call);
        stationSend(parts, renderParts(parts));
        break;
      }

      case 'confirm': {
        const parts = buildConfirm(contact.call);
        stationSend(parts, renderParts(parts));
        break;
      }

      case 'exchange': {
        // Save the user's exchange transmission for the grader, then key
        // the station's reply.
        exchangeParseRef.current = parsed;
        const parts = buildExchangeReply(
          userNameRef.current,
          replyRstRef.current,
          contact.state
        );
        stationSend(parts, renderParts(parts));
        break;
      }

      case 'repeat_exchange': {
        const parts = buildExchangeReply(
          userNameRef.current,
          replyRstRef.current,
          contact.state
        );
        stationSend(parts, renderParts(parts));
        break;
      }

      case 'close':
        finishQso(parsed);
        break;

      default:
        break;
    }

    if (nextPhase !== phaseRef.current) {
      setPhase(nextPhase);
      phaseRef.current = nextPhase;
    }
  }, [appendTranscript, stationSend, renderParts, finishQso]);

  // ── Char ingest: drives boundary detection ───────────────────────────
  const ingestChar = useCallback((ch) => {
    if (typeof ch !== 'string' || ch.length === 0) return;
    if (phaseRef.current === 'idle' || phaseRef.current === 'done') return;

    // Normalize: drop control bytes, uppercase, accept newline as space.
    let c = ch;
    if (c === '\r' || c === '\n') c = ' ';
    if (c.length !== 1) return;
    const code = c.charCodeAt(0);
    if (code < 0x20 || code > 0x7E) return;
    c = c.toUpperCase();

    bufferRef.current += c;

    // Boundary 1: a `?` arrives — request, flush immediately.
    if (c === '?') {
      flushBuffer();
      return;
    }

    // Boundary 2: whitespace AFTER a `BK` token — explicit "back to you".
    if (c === ' ') {
      const trimmed = bufferRef.current.trim();
      const tokens = trimmed.split(/\s+/);
      const last = tokens[tokens.length - 1];
      if (last === 'BK') {
        flushBuffer();
        return;
      }
    }

    // Boundary 3: quiet timeout. Reset on every char.
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flushBuffer();
    }, QUIET_TIMEOUT_MS);
  }, [flushBuffer]);

  // ── Subscribe to wkusb paddle echo while active ──────────────────────
  useEffect(() => {
    if (!active) return undefined;
    const unsubscribe = wkusbOnChar((ch) => ingestChar(ch));
    return () => {
      unsubscribe();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [active, ingestChar]);

  // ── Session lifecycle ────────────────────────────────────────────────
  const startSession = useCallback(async () => {
    if (!userCallsign) {
      setError(new Error('No callsign set — solo mode needs your callsign for grading.'));
      setStatus('error');
      return;
    }
    // StrictMode + race guard. If a session has already been initiated
    // (or is mid-fetch), bail out — calling this twice would shift two
    // different contacts off the pool and key them both before the user
    // could react.
    if (sessionStartedRef.current) return;
    sessionStartedRef.current = true;

    setStatus('loading');
    setError(null);
    setLogEntries([]);
    setTranscript([]);
    setLastQsoResult(null);

    try {
      // Look up the user's own name (cached) in parallel with the pool fetch.
      const [pool, name] = await Promise.all([
        buildSessionPool(),
        lookupUserName(userCallsign),
      ]);

      setUserName(name);
      userNameRef.current = name;
      setPark(pool.park);
      poolRef.current = [...pool.contacts];
      setStatus('running');
      startNextQso();
    } catch (err) {
      console.error('[solo] startSession failed', err);
      setError(err);
      setStatus('error');
      // Allow retry on failure.
      sessionStartedRef.current = false;
    }
  }, [userCallsign, startNextQso]);

  const endSession = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    bufferRef.current = '';
    poolRef.current = [];
    contactRef.current = null;
    dummyRstRef.current = null;
    replyRstRef.current = null;
    exchangeParseRef.current = null;
    phaseRef.current = 'idle';
    sessionStartedRef.current = false;
    setStatus('idle');
    setPhase('idle');
    setCurrentContact(null);
    setCurrentDummyRst(null);
    setCurrentReplyRst(null);
    setCallKeyedCorrectly(false);
    setTranscript([]);
    // Note: logEntries + sessionScore intentionally persist until reset.
  }, []);

  const resetScore = useCallback(() => {
    setSessionScore(0);
    writeCachedScore(0);
    setLogEntries([]);
  }, []);

  // ── Public API ───────────────────────────────────────────────────────
  return {
    // status & metadata
    status,
    error,
    park,
    userName,

    // active QSO state
    phase,
    currentContact,
    currentDummyRst,
    currentReplyRst,
    callKeyedCorrectly,

    // history
    logEntries,
    transcript,
    sessionScore,
    lastQsoResult,

    // actions
    startSession,
    endSession,
    resetScore,
    feedChar: ingestChar,
  };
}
