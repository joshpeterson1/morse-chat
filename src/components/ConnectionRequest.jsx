export default function ConnectionRequest({ from, onAccept, onDecline }) {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>Incoming connection</h2>
        <p style={{ margin: 0 }}>
          <strong>{from}</strong> wants to connect with you.
        </p>
        <div className="modal-actions">
          <button onClick={onDecline}>Decline</button>
          <button className="primary" onClick={onAccept}>
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
