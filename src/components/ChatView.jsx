import { useEffect, useMemo, useRef } from 'react';
import { onChar as onWkusbChar, sendText as wkusbSendText } from '../lib/wkusb.js';

// Renders the active pair session. Each keypress is sent immediately as a
// `morse-text` event so the experience matches keyer-style live transmission
// — there's no editable buffer, just a "type to send" surface that mirrors
// what a paddle would feel like. The chat stream above is the source of
// truth for what you've sent.
//
// Incoming WKUSB chars (when the stub eventually emits them) are routed
// straight into onSend so they're broadcast to the paired user the same way.
export default function ChatView({
  me,
  them,
  messages,
  onSend,
  onDisconnect,
  wkusbConnected,
}) {
  const streamRef = useRef(null);
  const inputRef = useRef(null);
  const playedThroughIndex = useRef(0);

  // Bridge WKUSB paddle input → outgoing publish. The wkusb module is a
  // singleton, so the listener is harmless even when no device is attached.
  useEffect(() => {
    return onWkusbChar((ch) => onSend(ch));
  }, [onSend]);

  // Auto-scroll the chat stream as new messages arrive.
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [messages]);

  // Play any new "them" messages on the local WKUSB so the operator hears
  // their partner's keying as Morse on the sidetone. The cursor only
  // advances forward, so a message is never re-played.
  useEffect(() => {
    if (!wkusbConnected) {
      // If the device isn't connected, advance the cursor anyway so we
      // don't dump a backlog the moment it gets connected mid-session.
      playedThroughIndex.current = messages.length;
      return;
    }
    for (let i = playedThroughIndex.current; i < messages.length; i++) {
      const m = messages[i];
      if (m.from === 'them' && m.text) {
        wkusbSendText(m.text);
      }
    }
    playedThroughIndex.current = messages.length;
  }, [messages, wkusbConnected]);

  // Group consecutive messages from the same sender into a single line so
  // the per-character publishes don't render as 100 separate rows.
  const grouped = useMemo(() => {
    const groups = [];
    for (const m of messages) {
      const last = groups[groups.length - 1];
      if (last && last.from === m.from) {
        last.text += m.text;
      } else {
        groups.push({ from: m.from, text: m.text });
      }
    }
    return groups;
  }, [messages]);

  function handleKeyDown(e) {
    // Let modifier-only and navigation keys through (Tab, etc).
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      onSend('\n');
      // \n is non-printable so wkusb.sendText drops it; we still notify the
      // pair so the line break appears in the chat stream.
      return;
    }

    // Single printable character — send to the pair AND play it on the local
    // keyer so the operator hears/transmits their own typing.
    if (e.key.length === 1) {
      e.preventDefault();
      onSend(e.key);
      if (wkusbConnected) wkusbSendText(e.key);
    }
    // Backspace / Delete / arrows / etc. are ignored — keying is one-way.
  }

  function handlePaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (text) {
      onSend(text);
      if (wkusbConnected) wkusbSendText(text);
    }
  }

  return (
    <div className="card chat-view">
      <div className="chat-header">
        <div>
          <strong>Connected with {them}</strong>
          <div className="muted">You: {me}</div>
        </div>
        <button className="danger" onClick={onDisconnect}>
          Disconnect
        </button>
      </div>

      <div className="chat-stream" ref={streamRef}>
        {grouped.length === 0 && (
          <div className="muted">
            No messages yet. Start typing — each character is sent live.
          </div>
        )}
        {grouped.map((g, i) => (
          <div key={i} className={`chat-line ${g.from}`}>
            <span className="who">{g.from === 'me' ? me : them}:</span>
            <span>{g.text}</span>
          </div>
        ))}
      </div>

      <div className="chat-input-row">
        <input
          ref={inputRef}
          type="text"
          value=""
          onChange={() => {
            /* controlled-empty: all sends happen via onKeyDown / onPaste */
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Type to send (each char goes live; Enter for newline)"
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}
