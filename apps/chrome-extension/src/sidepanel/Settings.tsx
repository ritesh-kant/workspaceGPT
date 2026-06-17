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

  const update = (patch: Partial<ChromeSettings>) => {
    setSettings({ ...settings, ...patch });
    setSaved(false);
  };

  const save = async () => {
    await saveSettings(settings);
    setSaved(true);
  };

  const isProxy = settings.vectorStoreMode === 'proxy';

  return (
    <div className='settings'>
      <div className='field-group-title'>Vector Storage</div>
      <div className='field'>
        <label>Mode</label>
        <select
          value={settings.vectorStoreMode}
          onChange={(e) =>
            update({ vectorStoreMode: e.target.value as 'direct' | 'proxy' })
          }
        >
          <option value='direct'>Direct (personal — your own Qdrant)</option>
          <option value='proxy'>Proxy (team — admin-hosted backend)</option>
        </select>
      </div>

      {isProxy ? (
        <>
          <div className='field'>
            <label>Proxy URL</label>
            <input
              type='text'
              value={settings.proxy.url}
              placeholder='https://your-proxy.vercel.app'
              onChange={(e) => update({ proxy: { ...settings.proxy, url: e.target.value } })}
            />
          </div>
          <div className='field'>
            <label>Access Token</label>
            <input
              type='password'
              value={settings.proxy.accessToken}
              placeholder='Token from your admin'
              onChange={(e) =>
                update({ proxy: { ...settings.proxy, accessToken: e.target.value } })
              }
            />
          </div>
        </>
      ) : (
        <>
          <div className='field'>
            <label>Qdrant URL</label>
            <input
              type='text'
              value={settings.qdrant.url}
              placeholder='https://your-cluster.qdrant.io:6333'
              onChange={(e) => update({ qdrant: { ...settings.qdrant, url: e.target.value } })}
            />
          </div>
          <div className='field'>
            <label>Qdrant API Key (read-only recommended)</label>
            <input
              type='password'
              value={settings.qdrant.apiKey}
              onChange={(e) => update({ qdrant: { ...settings.qdrant, apiKey: e.target.value } })}
            />
          </div>
        </>
      )}

      <div className='field-group-title'>Embeddings (Gemini)</div>
      <div className='field'>
        <label>Gemini API Key</label>
        <input
          type='password'
          value={settings.embedding.apiKey}
          onChange={(e) => update({ embedding: { apiKey: e.target.value } })}
        />
      </div>

      <div className='field-group-title'>Chat Model</div>
      <div className='field'>
        <label>Base URL (OpenAI-compatible)</label>
        <input
          type='text'
          value={settings.llm.baseUrl}
          onChange={(e) => update({ llm: { ...settings.llm, baseUrl: e.target.value } })}
        />
      </div>
      <div className='field'>
        <label>Model</label>
        <input
          type='text'
          value={settings.llm.model}
          onChange={(e) => update({ llm: { ...settings.llm, model: e.target.value } })}
        />
      </div>
      <div className='field'>
        <label>API Key</label>
        <input
          type='password'
          value={settings.llm.apiKey}
          onChange={(e) => update({ llm: { ...settings.llm, apiKey: e.target.value } })}
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
