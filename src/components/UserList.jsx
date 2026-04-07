export default function UserList({ users, me, onConnect, busy }) {
  const others = users.filter((u) => u !== me);

  if (others.length === 0) {
    return (
      <div className="card">
        <strong>Nobody else is online</strong>
        <div className="muted" style={{ marginTop: '0.4rem' }}>
          When another user appears online, they'll show up here.
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <strong>Online ({others.length})</strong>
      <ul className="user-list" style={{ marginTop: '0.7rem' }}>
        {others.map((u) => (
          <li key={u} className="user-row">
            <span>{u}</span>
            <button className="primary" onClick={() => onConnect(u)} disabled={busy}>
              Connect
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
