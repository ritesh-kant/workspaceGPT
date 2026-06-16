import React from 'react';
import { useSettingsStore } from '../../store';

const VectorStoreSettings: React.FC = () => {
  const { config, updateConfig } = useSettingsStore();
  // Fall back to the default when older persisted settings lack the section.
  const vectorStore = config.vectorStore ?? {
    location: 'local' as const,
    qdrantUrl: '',
    qdrantApiKey: '',
  };

  return (
    <div className='settings-section'>
      <div className='section-header'>
        <h3>Vector Storage</h3>
      </div>
      <div className='settings-form'>
        <div className='form-group'>
          <label htmlFor='vectorstore-location-select'>Storage Location</label>
          <select
            id='vectorstore-location-select'
            className='select-larger'
            value={vectorStore.location}
            onChange={(e) =>
              updateConfig('vectorStore', 'location', e.target.value as 'local' | 'cloud')
            }
          >
            <option value='local'>Local (on this machine)</option>
            <option value='cloud'>Cloud — Qdrant (shareable)</option>
          </select>
          <small className='form-text'>
            Local keeps the index in extension storage. Cloud stores it in Qdrant
            so it can be shared. Switching requires re-indexing your sources.
          </small>
        </div>

        {vectorStore.location === 'cloud' && (
          <>
            <div className='form-group'>
              <label htmlFor='qdrant-url'>Qdrant URL</label>
              <input
                id='qdrant-url'
                type='text'
                value={vectorStore.qdrantUrl ?? ''}
                onChange={(e) => updateConfig('vectorStore', 'qdrantUrl', e.target.value)}
                placeholder='https://your-cluster.qdrant.io:6333'
              />
            </div>
            <div className='form-group'>
              <label htmlFor='qdrant-api-key'>Qdrant API Key</label>
              <input
                id='qdrant-api-key'
                type='password'
                value={vectorStore.qdrantApiKey ?? ''}
                onChange={(e) => updateConfig('vectorStore', 'qdrantApiKey', e.target.value)}
                placeholder='Enter your Qdrant API key'
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default VectorStoreSettings;
