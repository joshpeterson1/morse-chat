export default function OutgoingRequest({ to, onCancel }) {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>Waiting…</h2>
        <p style={{ margin: 0 }}>
          Sent connection request to <strong>{to}</strong>. Waiting for them to respond.
        </p>
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
