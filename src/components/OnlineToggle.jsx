export default function OnlineToggle({ online, onToggle, disabled }) {
  return (
    <div className="card online-toggle">
      <div>
        <div>
          <span className={`status-dot ${online ? 'online' : ''}`}></span>
          <strong>{online ? 'You are online' : 'You are offline'}</strong>
        </div>
        <div className="muted" style={{ marginTop: '0.3rem' }}>
          {online
            ? 'Other users can see your callsign and request to connect.'
            : 'Toggle on to appear in the user list.'}
        </div>
      </div>
      <button
        className={online ? '' : 'primary'}
        onClick={() => onToggle(!online)}
        disabled={disabled}
      >
        {online ? 'Go offline' : 'Appear online'}
      </button>
    </div>
  );
}
