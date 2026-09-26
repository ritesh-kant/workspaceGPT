import React, { useEffect, useState } from 'react';
import { ChromeSettings, decodeShareCode, isConfigured, loadSettings, saveSettings } from '../lib/storage';
import { BRIDGE_PERMISSIONS, BRIDGE_STATUS_KEY, BROWSER_CONTROL_KEY, BridgeStatus } from '../lib/browserControl';

/** The desktop agent's access to this browser — off until the user turns it on. */
const BrowserAccess: React.FC = () => {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<BridgeStatus | null>(null);

  useEffect(() => {
    chrome.storage.local.get([BROWSER_CONTROL_KEY, BRIDGE_STATUS_KEY]).then((s) => {
      setEnabled(s[BROWSER_CONTROL_KEY] === true);
      setStatus(s[BRIDGE_STATUS_KEY] ?? null);
    });
    const onChange = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && BRIDGE_STATUS_KEY in changes) setStatus(changes[BRIDGE_STATUS_KEY].newValue ?? null);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const [denied, setDenied] = useState(false);

  // Must run straight from the click: Chrome only shows a permission prompt inside a user gesture.
  const toggle = async (next: boolean) => {
    setDenied(false);
    if (next && !(await chrome.permissions.request(BRIDGE_PERMISSIONS))) {
      setDenied(true);
      return;
    }
    setEnabled(next);
    await chrome.storage.local.set({ [BROWSER_CONTROL_KEY]: next });
    if (!next) await chrome.permissions.remove(BRIDGE_PERMISSIONS).catch(() => undefined);
  };

  return (
    <>
      <div className='field-group-title' style={{ marginTop: 20 }}>WorkspaceGPT Desktop</div>
      <label className='settings-hint' style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <input type='checkbox' checked={enabled} onChange={(e) => void toggle(e.target.checked)} />
        <span>
          Let WorkspaceGPT use this browser. The desktop agent can read your tabs, and open, click, type and fill
          forms in its own &ldquo;WorkspaceGPT&rdquo; tab group or the tab you are looking at — using the sites you are
          already signed in to. Chrome shows a &ldquo;debugging this browser&rdquo; bar while it acts; click Cancel there
          to stop it. Chrome asks for permission first; turning this off removes it.
        </span>
      </label>
      {denied && <p className='settings-hint'>Chrome permission was not granted, so this stays off.</p>}
      {enabled && status && (
        <p className='settings-hint'>
          {status.connected
            ? '✓ Connected to WorkspaceGPT Desktop'
            : /not found/i.test(status.error ?? '')
              ? 'Not connected — WorkspaceGPT Desktop 0.0.5 or later is not installed. Install or update it, then open it once.'
              : `Not connected — ${(status.error ?? 'waiting').replace(/\.+$/, '')}. Is WorkspaceGPT Desktop running?`}
        </p>
      )}
    </>
  );
};

interface Props {
  onClose: () => void;
}

const Settings: React.FC<Props> = ({ onClose }) => {
  const [settings, setSettings] = useState<ChromeSettings | null>(null);
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; msg: string } | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  if (!settings) return <div className='settings'>Loading…</div>;

  const connected = isConfigured(settings);

  const connect = async () => {
    try {
      const next = decodeShareCode(code);
      await saveSettings(next);
      setSettings(next);
      setCode('');
      setStatus({ kind: 'ok', msg: 'Connected ✓' });
    } catch (err) {
      setStatus({ kind: 'error', msg: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className='settings'>
      <div className='field-group-title'>Connection</div>
      <ol className='settings-steps'>
        <li>
          Continue the setup in the <strong>WorkspaceGPT VS Code extension</strong> and
          finish connecting your knowledge base.
        </li>
        <li>
          There, open <em>Settings → Share to Chrome → “Create share code”</em>.
        </li>
        <li>Paste your share code below and hit Connect.</li>
      </ol>
      <p className='settings-hint'>
        This links the extension to that knowledge base — no API keys to enter
        manually. New here? Get started at{' '}
        <a href='https://www.workspacegpt.in' target='_blank' rel='noopener noreferrer'>
          workspacegpt.in
        </a>
        .
      </p>

      {connected && (
        <p className='settings-hint' style={{ opacity: 0.9 }}>
          ✓ Connected to <code>{settings.qdrant.url}</code>
        </p>
      )}

      <div className='field'>
        <label>Share code</label>
        <textarea
          rows={4}
          value={code}
          placeholder='Paste your share code'
          onChange={(e) => {
            setCode(e.target.value);
            setStatus(null);
          }}
        />
      </div>

      {status && (
        <p className='settings-hint' style={{ color: status.kind === 'error' ? '#e06c75' : 'inherit' }}>
          {status.msg}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          className='primary-button'
          onClick={connect}
          disabled={!code.trim()}
          style={{ padding: '8px 14px' }}
        >
          {connected ? 'Update connection' : 'Connect'}
        </button>
        <button className='icon-button' onClick={onClose}>
          Close
        </button>
      </div>

      <BrowserAccess />
    </div>
  );
};

export default Settings;
