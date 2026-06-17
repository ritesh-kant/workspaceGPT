import React, { useEffect, useState } from 'react';
import { ChromeSettings, loadSettings, saveSettings } from '../lib/storage';

interface Props {
  onClose: () => void;
}

const Settings: React.FC<Props> = ({ onClose }) => {
  const [settings, setSettings] = useState<ChromeSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  if (!settings) return <div className='settings'>Loading…</div>;

  const save = async () => {
    await saveSettings(settings);
    setSaved(true);
  };

  return (
    <div className='settings'>
      <div className='field-group-title'>Connection</div>
      <p className='settings-hint'>
        Paste the share code from WorkspaceGPT in VS Code. It connects this
        extension to your team's knowledge base — no API keys needed here.
      </p>
      <div className='field'>
        <label>Share code</label>
        <input
          type='password'
          value={settings.shareToken}
          placeholder='Paste your share code'
          onChange={(e) => {
            setSettings({ shareToken: e.target.value.trim() });
            setSaved(false);
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className='primary-button' onClick={save} style={{ padding: '8px 14px' }}>
          {saved ? 'Saved ✓' : 'Save'}
        </button>
        <button className='icon-button' onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
};

export default Settings;
