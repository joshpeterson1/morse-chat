import { useState } from 'react';

const KEY_MODE_OPTIONS = [
  { value: 'iambicA',   label: 'Iambic A' },
  { value: 'iambicB',   label: 'Iambic B' },
  { value: 'ultimatic', label: 'Ultimatic' },
  { value: 'bug',       label: 'Bug' },
];

export default function WkusbSettings({
  connected,
  settings,
  onWpmChange,
  onMaxWpmChange,
  onSidetoneEnabledChange,
  onSidetoneHzChange,
  onKeyModeChange,
  onPttEnabledChange,
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="card wkusb-settings">
      <button
        type="button"
        className="settings-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <strong>WKUSB settings</strong>
        <span className="muted">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="settings-body">
          {!connected && (
            <div className="muted" style={{ marginBottom: '0.6rem' }}>
              Not connected — changes are saved and applied on next connect.
            </div>
          )}

          <div className="settings-row">
            <label htmlFor="wkusb-wpm">
              Speed
              <span className="value-tag">{settings.wpm} WPM</span>
            </label>
            <input
              id="wkusb-wpm"
              type="range"
              min={settings.minWpm}
              max={settings.maxWpm}
              step={1}
              value={settings.wpm}
              onChange={(e) => onWpmChange(parseInt(e.target.value, 10))}
            />
          </div>

          <div className="settings-row">
            <label htmlFor="wkusb-max-wpm">
              Max speed (slider upper bound)
              <span className="value-tag">{settings.maxWpm} WPM</span>
            </label>
            <input
              id="wkusb-max-wpm"
              type="range"
              min={settings.minWpm + 5}
              max={settings.protocolMaxWpm}
              step={1}
              value={settings.maxWpm}
              onChange={(e) => onMaxWpmChange(parseInt(e.target.value, 10))}
            />
          </div>

          <div className="settings-row">
            <label htmlFor="wkusb-key-mode">
              Key mode
              <span className="value-tag">
                {KEY_MODE_OPTIONS.find((o) => o.value === settings.keyMode)?.label ?? settings.keyMode}
              </span>
            </label>
            <select
              id="wkusb-key-mode"
              value={settings.keyMode}
              onChange={(e) => onKeyModeChange(e.target.value)}
            >
              {KEY_MODE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="settings-row inline">
            <label htmlFor="wkusb-sidetone">
              <input
                id="wkusb-sidetone"
                type="checkbox"
                checked={settings.sidetoneEnabled}
                onChange={(e) => onSidetoneEnabledChange(e.target.checked)}
              />
              Sidetone audio
            </label>
          </div>

          <div className="settings-row">
            <label htmlFor="wkusb-sidetone-hz">
              Sidetone frequency
              <span className="value-tag">{settings.sidetoneHz} Hz</span>
            </label>
            <input
              id="wkusb-sidetone-hz"
              type="range"
              min={settings.minSidetoneHz}
              max={settings.maxSidetoneHz}
              step={10}
              value={settings.sidetoneHz}
              disabled={!settings.sidetoneEnabled}
              onChange={(e) => onSidetoneHzChange(parseInt(e.target.value, 10))}
            />
          </div>

          <div className="settings-row inline">
            <label htmlFor="wkusb-ptt">
              <input
                id="wkusb-ptt"
                type="checkbox"
                checked={settings.pttEnabled}
                onChange={(e) => onPttEnabledChange(e.target.checked)}
              />
              PTT enable (transmit on radio)
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
