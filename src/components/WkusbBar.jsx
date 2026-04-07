export default function WkusbBar({
  supported,
  connected,
  connecting,
  busy,
  error,
  onConnect,
  onDisconnect,
}) {
  if (!supported) {
    return (
      <div className="card wkusb-bar">
        <div>
          <strong>WKUSB unavailable</strong>
          <div className="muted">
            Web Serial requires Chrome or Edge over HTTPS or localhost.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card wkusb-bar">
      <div>
        <div>
          <span className={`status-dot ${connected ? 'online' : ''}`}></span>
          <strong>
            {connected
              ? busy
                ? 'WKUSB: keying'
                : 'WKUSB: connected'
              : 'WKUSB: not connected'}
          </strong>
        </div>
        <div className="muted" style={{ marginTop: '0.3rem' }}>
          {connected
            ? 'Paddle input is forwarded to chat. Incoming chars play locally.'
            : 'Connect your WKUSB / WKMini / WKUSB-AF to key over the air.'}
        </div>
        {error && (
          <div className="muted" style={{ color: 'var(--bad)', marginTop: '0.3rem' }}>
            {error.message || String(error)}
          </div>
        )}
      </div>
      {connected ? (
        <button onClick={onDisconnect}>Disconnect</button>
      ) : (
        <button className="primary" onClick={onConnect} disabled={connecting}>
          {connecting ? 'Connecting…' : 'Connect WKUSB'}
        </button>
      )}
    </div>
  );
}
