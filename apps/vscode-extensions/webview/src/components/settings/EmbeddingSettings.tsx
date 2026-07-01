import React from 'react';
import { useSettingsStore } from '../../store';

const EmbeddingSettings: React.FC = () => {
  const { config, updateConfig } = useSettingsStore();
  // Fall back to the default when older persisted settings lack the section.
  const embedding = config.embedding ?? { provider: 'local' as const, apiKey: '' };

  // Configured Gemini keys (falls back to the legacy single key).
  const apiKeys: string[] =
    embedding.apiKeys && embedding.apiKeys.length > 0
      ? embedding.apiKeys
      : [embedding.apiKey ?? ''];
  const configuredKeyCount = apiKeys.filter((k) => k.trim()).length;

  // Persist a new key list, keeping apiKey synced to the first entry.
  const setApiKeys = (keys: string[]) => {
    updateConfig('embedding', 'apiKeys', keys);
    updateConfig('embedding', 'apiKey', keys[0] ?? '');
  };
  const updateApiKeyAt = (i: number, value: string) =>
    setApiKeys(apiKeys.map((k, idx) => (idx === i ? value : k)));
  const addApiKey = () => setApiKeys([...apiKeys, '']);
  const removeApiKeyAt = (i: number) => {
    const next = apiKeys.filter((_, idx) => idx !== i);
    setApiKeys(next.length ? next : ['']);
  };

  return (
    <div className='settings-section'>
      <div className='section-header'>
        <h3>Embedding Settings</h3>
      </div>
      <div className='settings-form'>
        <div className='form-group'>
          <label htmlFor='embedding-provider-select'>Embedding Provider</label>
          <select
            id='embedding-provider-select'
            className='select-larger'
            value={embedding.provider}
            onChange={(e) =>
              updateConfig('embedding', 'provider', e.target.value as 'local' | 'gemini')
            }
          >
            <option value='local'>Local (on-device, private)</option>
            <option value='gemini'>Google Gemini (cloud, shareable)</option>
          </select>
          <small className='form-text'>
            Local runs fully on-device. Gemini is required to share your index.
            Switching providers will prompt you to re-index your connected sources.
          </small>
        </div>

        {embedding.provider === 'gemini' && (
          <div className='form-group'>
            <details className='dep-details'>
              <summary>
                Gemini API Key(s) · {configuredKeyCount} configured
              </summary>
              <div className='dep-details-body'>
                {apiKeys.map((key, i) => (
                  <div key={i} className='api-key-row'>
                    <input
                      id={i === 0 ? 'embedding-api-key' : undefined}
                      type='password'
                      value={key}
                      onChange={(e) => updateApiKeyAt(i, e.target.value)}
                      placeholder={
                        i === 0 ? 'Enter your Google Gemini API key' : `Fallback key #${i + 1}`
                      }
                    />
                    {apiKeys.length > 1 && (
                      <button
                        type='button'
                        className='dep-icon-button dep-icon-danger'
                        onClick={() => removeApiKeyAt(i)}
                        data-tooltip='Remove key'
                        aria-label='Remove key'
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button type='button' className='add-key-button' onClick={addApiKey}>
                  + Add API key
                </button>
                <small className='form-text'>
                  Used to embed documents and queries with gemini-embedding-001. Extra keys
                  are tried in order if one is rate-limited (HTTP 429) — useful for spreading
                  free-tier quota across multiple keys.
                </small>
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  );
};

export default EmbeddingSettings;
