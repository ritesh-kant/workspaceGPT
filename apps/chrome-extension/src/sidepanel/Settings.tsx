import React, { useEffect, useState } from 'react';
import { ChromeSettings, decodeShareCode, isConfigured, loadSettings, saveSettings } from '../lib/storage';

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
      <p className='settings-hint'>
        In VS Code, open WorkspaceGPT Settings → Share to Chrome → “Create share
        code”, then paste it here. It connects this extension to that knowledge
        base — no API keys to enter manually.
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
    </div>
  );
};

export default Settings;
