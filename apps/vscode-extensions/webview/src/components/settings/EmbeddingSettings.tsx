import React from 'react';
import { useSettingsStore } from '../../store';

const EmbeddingSettings: React.FC = () => {
  const { config, updateConfig } = useSettingsStore();
  // Fall back to the default when older persisted settings lack the section.
  const embedding = config.embedding ?? { provider: 'local' as const, apiKey: '' };

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
            <label htmlFor='embedding-api-key'>Gemini API Key</label>
            <input
              id='embedding-api-key'
              type='password'
              value={embedding.apiKey ?? ''}
              onChange={(e) => updateConfig('embedding', 'apiKey', e.target.value)}
              placeholder='Enter your Google Gemini API key'
            />
            <small className='form-text'>
              Used to embed documents and queries with gemini-embedding-001.
            </small>
          </div>
        )}
      </div>
    </div>
  );
};

export default EmbeddingSettings;
