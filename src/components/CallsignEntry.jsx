import { useState } from 'react';

export default function CallsignEntry({ onSubmit }) {
  const [value, setValue] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Enter your callsign</h2>
      <p className="muted">
        Stored locally on this device. Other users see this when you appear online.
      </p>
      <form onSubmit={handleSubmit} className="chat-input-row">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value.toUpperCase())}
          placeholder="W1AW"
          autoFocus
          maxLength={16}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" className="primary" disabled={!value.trim()}>
          Continue
        </button>
      </form>
    </div>
  );
}
