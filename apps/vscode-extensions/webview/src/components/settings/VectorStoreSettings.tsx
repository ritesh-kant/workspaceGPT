import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES, normalizeQdrantUrl } from '../../constants';

interface QdrantTestResult {
  ok: boolean;
  detail: string;
}

const VectorStoreSettings: React.FC = () => {
  const { config, updateConfig } = useSettingsStore();
  const vscode = VSCodeAPI();
  // Fall back to the default when older persisted settings lack the section.
  const vectorStore = config.vectorStore ?? {
    location: 'local' as const,
    qdrantUrl: '',
    qdrantApiKey: '',
  };

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<QdrantTestResult | null>(null);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === MESSAGE_TYPES.TEST_QDRANT_CONNECTION_RESULT) {
        setIsTesting(false);
        setTestResult({ ok: !!message.ok, detail: message.detail });
        // Surface the normalized URL the extension actually used (e.g. with :6333).
        if (message.url && message.url !== vectorStore.qdrantUrl) {
          updateConfig('vectorStore', 'qdrantUrl', message.url);
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [vectorStore.qdrantUrl]);

  // Normalize on blur so a bare Qdrant Cloud URL gets its :6333 port before save.
  const normalizeUrlOnBlur = () => {
    const normalized = normalizeQdrantUrl(vectorStore.qdrantUrl);
    if (normalized !== (vectorStore.qdrantUrl ?? '')) {
      updateConfig('vectorStore', 'qdrantUrl', normalized);
    }
  };

  const testConnection = () => {
    setTestResult(null);
    setIsTesting(true);
    vscode.postMessage({
      type: MESSAGE_TYPES.TEST_QDRANT_CONNECTION,
      config: {
        qdrantUrl: vectorStore.qdrantUrl,
        qdrantApiKey: vectorStore.qdrantApiKey,
      },
    });
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
                onBlur={normalizeUrlOnBlur}
                placeholder='https://your-cluster.qdrant.io:6333'
              />
              <small className='form-text'>
                Use the cluster endpoint with port <code>:6333</code> — the dashboard
                shows it without the port. It's added automatically for Qdrant Cloud URLs.
              </small>
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

            <div className='form-group'>
              <button
                onClick={testConnection}
                disabled={isTesting || !vectorStore.qdrantUrl}
              >
                {isTesting ? '⏳ Testing…' : '🔌 Test connection'}
              </button>
              {testResult && (
                <div
                  className={`status-message ${testResult.ok ? 'success' : 'error'}`}
                  style={{ marginTop: '8px' }}
                >
                  {testResult.ok ? '✅ ' : '❌ '}
                  {testResult.detail}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default VectorStoreSettings;
