import { useEffect, useRef } from 'react';
import { useSoloQso } from '../hooks/useSoloQso.js';
import { toCutNumbers } from '../lib/cqpota/cutNumbers.js';

// Solo CQ POTA practice view. Replaces the lobby/userlist when the user
// activates Solo mode. Hosts the working log, the running session score,
// the live transcript of the active QSO, and a typing surface for users
// who want to key with their keyboard alongside (or instead of) the
// paddle. Paddle echoes route through the hook directly via wkusb.onChar,
// so they don't need to flow through this component at all.
export default function SoloMode({ me, wkusbConnected, onExit }) {
  const solo = useSoloQso({ active: true, userCallsign: me });
  const inputRef = useRef(null);
  const transcriptRef = useRef(null);

  // Auto-start the session as soon as the view mounts. Deliberately no
  // cleanup that calls endSession(): React 18 StrictMode fires this effect
  // twice in dev (mount → cleanup → mount), and resetting the session in
  // the cleanup would let the second mount fire startSession() again.
  // The hook's startSession() is ref-guarded against double-calls so this
  // is safe even without the cleanup, and the wkusb listener teardown
  // happens inside the hook's own effect (which fires on real unmount).
  // Explicit "End session" button still calls solo.endSession() via
  // handleExit below.
  useEffect(() => {
    if (solo.status === 'idle' && wkusbConnected) {
      solo.startSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll the transcript when it grows.
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [solo.transcript]);

  function handleKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      solo.feedChar(' ');
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      solo.feedChar(e.key);
    }
  }

  function handleExit() {
    solo.endSession();
    onExit();
  }

  // Body content varies by status — loading / error / running.
  let body;
  if (!wkusbConnected) {
    body = (
      <div className="card">
        <strong>WKUSB required</strong>
        <div className="muted" style={{ marginTop: '0.4rem' }}>
          Solo mode keys the calling station's transmissions on your hardware. Connect your WKUSB above to start.
        </div>
      </div>
    );
  } else if (solo.status === 'loading') {
    body = (
      <div className="card">
        <strong>Spinning up a session...</strong>
        <div className="muted" style={{ marginTop: '0.4rem' }}>
          Picking a park, pulling activations, looking up operators.
        </div>
      </div>
    );
  } else if (solo.status === 'error') {
    body = (
      <div className="card">
        <strong>Couldn't start solo session</strong>
        <div className="muted" style={{ marginTop: '0.4rem' }}>
          {solo.error?.message || 'Unknown error'}
        </div>
        <button
          className="primary"
          style={{ marginTop: '0.6rem' }}
          onClick={() => solo.startSession()}
        >
          Try again
        </button>
      </div>
    );
  } else if (solo.status === 'empty') {
    body = (
      <div className="card">
        <strong>Out of stations</strong>
        <div className="muted" style={{ marginTop: '0.4rem' }}>
          Worked everyone in the pool. End the session to start a fresh one.
        </div>
      </div>
    );
  } else {
    body = (
      <>
        <div className="card solo-active">
          <div className="solo-active-header">
            <div>
              <div className="muted">Now calling you</div>
              <div className="solo-now-name">
                {solo.currentContact?.name || '—'}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="muted">Send them</div>
              <div className="solo-now-rst">
                {solo.currentDummyRst ? toCutNumbers(solo.currentDummyRst) : '—'}
              </div>
            </div>
          </div>
          <div className="muted solo-hint">
            Park: <span className="value-tag">{solo.park}</span>
            {solo.userName && (
              <>
                {' '}· You: <span className="value-tag">{solo.userName}</span>
              </>
            )}
          </div>

          <div className="solo-transcript" ref={transcriptRef}>
            {solo.transcript.length === 0 && (
              <div className="muted">Listen for the call...</div>
            )}
            {solo.transcript.map((t, i) => (
              <div key={i} className={`chat-line ${t.from}`}>
                <span className="who">{t.from === 'me' ? me : 'STN:'}</span>
                <span>{t.text}</span>
              </div>
            ))}
          </div>

          <div className="chat-input-row">
            <input
              ref={inputRef}
              type="text"
              value=""
              onChange={() => { /* controlled-empty */ }}
              onKeyDown={handleKeyDown}
              placeholder="Key with the paddle, or type here. Send `BK` or `?` to hand it back."
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>

        {solo.lastQsoResult && solo.phase === 'done' && (
          <div className="card solo-result">
            <div className="solo-result-header">
              <div>
                <strong>QSO complete: {solo.lastQsoResult.contact.call}</strong>
                <div className="muted">
                  {solo.lastQsoResult.contact.name} · sent{' '}
                  {toCutNumbers(solo.lastQsoResult.dummyRst)} · rcvd{' '}
                  {toCutNumbers(solo.lastQsoResult.replyRst)}
                </div>
              </div>
              <div className="solo-result-total">
                +{solo.lastQsoResult.total}
              </div>
            </div>
            <ul className="solo-result-breakdown">
              {solo.lastQsoResult.breakdown.map((b, i) => (
                <li key={i}>
                  <span>{b.label}</span>
                  <span className="muted">{b.note || ''}</span>
                  <span className="value-tag">
                    {b.points}/{b.max}
                  </span>
                </li>
              ))}
              {solo.lastQsoResult.fbCount > 0 && (
                <li>
                  <span>FB multiplier</span>
                  <span className="muted">
                    {solo.lastQsoResult.fbCount} ×{' '}
                    {solo.lastQsoResult.multiplier.toFixed(1)}x
                  </span>
                  <span className="value-tag">
                    ={solo.lastQsoResult.total}
                  </span>
                </li>
              )}
            </ul>
          </div>
        )}

        {solo.logEntries.length > 0 && (
          <div className="card">
            <strong>Worked this session ({solo.logEntries.length})</strong>
            <table className="solo-log">
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Name</th>
                  <th>Sent</th>
                  <th>Rcvd</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {solo.logEntries.map((e, i) => (
                  <tr key={i}>
                    <td className="mono">{e.keyedCall || ''}</td>
                    <td>{e.contact.name}</td>
                    <td className="mono">{toCutNumbers(e.dummyRst)}</td>
                    <td className="mono">{toCutNumbers(e.replyRst)}</td>
                    <td>{e.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="solo-mode">
      <div className="card solo-header">
        <div>
          <strong>Solo: CQ POTA</strong>
          <div className="muted" style={{ marginTop: '0.2rem' }}>
            Practice exchanges against random POTA activators.
          </div>
        </div>
        <div className="solo-header-right">
          <div className="solo-score">
            <div className="muted">Session</div>
            <div className="solo-score-value">{solo.sessionScore}</div>
          </div>
          {solo.sessionScore > 0 && (
            <button onClick={solo.resetScore} title="Reset session score">
              Reset
            </button>
          )}
          <button className="danger" onClick={handleExit}>
            End session
          </button>
        </div>
      </div>

      {body}
    </div>
  );
}
