import { useCallback, useEffect, useState } from 'react';
import { useCallsign } from './hooks/useCallsign.js';
import { useAblyClient } from './hooks/useAblyClient.js';
import { usePresence } from './hooks/usePresence.js';
import { useInbox } from './hooks/useInbox.js';
import { usePairChannel } from './hooks/usePairChannel.js';
import { useWkusb } from './hooks/useWkusb.js';
import {
  sendConnectionRequest,
  sendConnectionAccept,
  sendConnectionDecline,
} from './lib/messaging.js';
import CallsignEntry from './components/CallsignEntry.jsx';
import OnlineToggle from './components/OnlineToggle.jsx';
import UserList from './components/UserList.jsx';
import ConnectionRequest from './components/ConnectionRequest.jsx';
import OutgoingRequest from './components/OutgoingRequest.jsx';
import ChatView from './components/ChatView.jsx';
import WkusbBar from './components/WkusbBar.jsx';
import WkusbSettings from './components/WkusbSettings.jsx';
import SoloMode from './components/SoloMode.jsx';

export default function App() {
  const [callsign, setCallsign] = useCallsign();
  const { client, state: connectionState } = useAblyClient(callsign);
  const wkusb = useWkusb();

  const [online, setOnline] = useState(false);
  const members = usePresence(client, online);

  const {
    pendingIncoming,
    setPendingIncoming,
    outgoingResult,
    setOutgoingResult,
  } = useInbox(client, callsign);

  const [outgoing, setOutgoing] = useState(null); // callsign we're requesting
  const [pairedWith, setPairedWith] = useState(null);
  const [soloMode, setSoloMode] = useState(false);

  const onRemoteDisconnect = useCallback(() => {
    setPairedWith(null);
  }, []);

  const { messages, sendText, sendDisconnect } = usePairChannel(
    client,
    callsign,
    pairedWith,
    onRemoteDisconnect
  );

  // Mutual-connect race: if we've sent an outgoing request to X and X also
  // sends one to us, treat it as accepted on both sides.
  useEffect(() => {
    if (
      pendingIncoming &&
      outgoing &&
      pendingIncoming.from === outgoing &&
      client
    ) {
      sendConnectionAccept(client, callsign, pendingIncoming.from);
      setPairedWith(pendingIncoming.from);
      setOutgoing(null);
      setPendingIncoming(null);
    }
  }, [pendingIncoming, outgoing, client, callsign, setPendingIncoming]);

  // Auto-decline incoming requests while we're already in a session.
  useEffect(() => {
    if (pairedWith && pendingIncoming && client) {
      sendConnectionDecline(client, callsign, pendingIncoming.from);
      setPendingIncoming(null);
    }
  }, [pairedWith, pendingIncoming, client, callsign, setPendingIncoming]);

  // Handle responses to our outgoing request.
  useEffect(() => {
    if (!outgoingResult || !outgoing) return;
    if (outgoingResult.from !== outgoing) {
      // Stale response from someone we're no longer asking. Drop it.
      setOutgoingResult(null);
      return;
    }
    if (outgoingResult.type === 'accept') {
      setPairedWith(outgoing);
      setOutgoing(null);
    } else {
      setOutgoing(null);
      // Could surface a toast — keeping it minimal for now.
      console.info(`${outgoingResult.from} declined`);
    }
    setOutgoingResult(null);
  }, [outgoingResult, outgoing, setOutgoingResult]);

  function handleConnectClick(target) {
    if (!client || outgoing || pairedWith) return;
    setOutgoing(target);
    sendConnectionRequest(client, callsign, target).catch((err) =>
      console.error('connection request failed', err)
    );
  }

  function handleAcceptIncoming() {
    if (!pendingIncoming || !client) return;
    sendConnectionAccept(client, callsign, pendingIncoming.from);
    setPairedWith(pendingIncoming.from);
    setPendingIncoming(null);
  }

  function handleDeclineIncoming() {
    if (!pendingIncoming || !client) return;
    sendConnectionDecline(client, callsign, pendingIncoming.from);
    setPendingIncoming(null);
  }

  function handleCancelOutgoing() {
    setOutgoing(null);
  }

  function handleEndChat() {
    sendDisconnect();
    setPairedWith(null);
  }

  function handleSendChar(text) {
    sendText(text);
  }

  function handleSignOut() {
    setOnline(false);
    setPairedWith(null);
    setOutgoing(null);
    setSoloMode(false);
    setCallsign('');
  }

  if (!callsign) {
    return (
      <div className="app">
        <div className="app-header">
          <h1>somber's morse chat</h1>
        </div>
        <CallsignEntry onSubmit={setCallsign} />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="app-header">
        <h1>somber's morse chat</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <span className="callsign-tag">{callsign}</span>
          <span className="connection-status">{connectionState}</span>
          <button onClick={handleSignOut}>Sign out</button>
        </div>
      </div>

      <WkusbBar
        supported={wkusb.supported}
        connected={wkusb.connected}
        connecting={wkusb.connecting}
        busy={wkusb.busy}
        error={wkusb.error}
        onConnect={wkusb.connect}
        onDisconnect={wkusb.disconnect}
      />

      {wkusb.supported && (
        <WkusbSettings
          connected={wkusb.connected}
          settings={wkusb.settings}
          onWpmChange={wkusb.setWpm}
          onMaxWpmChange={wkusb.setMaxWpm}
          onSidetoneEnabledChange={wkusb.setSidetoneEnabled}
          onSidetoneHzChange={wkusb.setSidetoneHz}
          onKeyModeChange={wkusb.setKeyMode}
          onPttEnabledChange={wkusb.setPttEnabled}
        />
      )}

      {pairedWith ? (
        <ChatView
          me={callsign}
          them={pairedWith}
          messages={messages}
          onSend={handleSendChar}
          onDisconnect={handleEndChat}
          wkusbConnected={wkusb.connected}
        />
      ) : soloMode ? (
        <SoloMode
          me={callsign}
          wkusbConnected={wkusb.connected}
          onExit={() => setSoloMode(false)}
        />
      ) : (
        <>
          <OnlineToggle
            online={online}
            onToggle={setOnline}
            disabled={connectionState !== 'connected'}
          />
          <div className="card online-toggle">
            <div>
              <strong>Solo: CQ POTA</strong>
              <div className="muted" style={{ marginTop: '0.3rem' }}>
                {wkusb.connected
                  ? 'Practice POTA exchanges against random activators when nobody is around.'
                  : 'Connect your WKUSB above to practice POTA exchanges solo.'}
              </div>
            </div>
            <button
              className="primary"
              onClick={() => setSoloMode(true)}
              disabled={!wkusb.connected}
            >
              Start solo
            </button>
          </div>
          <UserList
            users={members}
            me={callsign}
            onConnect={handleConnectClick}
            busy={!!outgoing}
          />
        </>
      )}

      {pendingIncoming && !pairedWith && (
        <ConnectionRequest
          from={pendingIncoming.from}
          onAccept={handleAcceptIncoming}
          onDecline={handleDeclineIncoming}
        />
      )}

      {outgoing && !pairedWith && (
        <OutgoingRequest to={outgoing} onCancel={handleCancelOutgoing} />
      )}
    </div>
  );
}
