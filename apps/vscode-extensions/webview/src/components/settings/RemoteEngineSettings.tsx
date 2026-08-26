import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES, normalizeQdrantUrl } from '../../constants';
import SectionShell from './SectionShell';

interface QdrantTestResult {
  ok: boolean;
  detail: string;
}

/**
 * The entire "engine" configuration for remote mode, in one card: the Gemini
 * key(s) used for both embeddings and (via the host's task routing) chat
 * inference, plus the Qdrant cloud connection. Local mode never shows this —
 * see ModelSettings for the local equivalent. Replaces EmbeddingSettings +
 * VectorStoreSettings' provider/location pickers, which don't apply once mode
 * fixes the provider — those components stay in the tree for the (dormant)
 * per-axis path but are not rendered from Settings anymore.
 */
const RemoteEngineSettings: React.FC = () => {
  const { config, updateConfig } = useSettingsStore();
  const vscode = VSCodeAPI();

  const embedding = config.embedding ?? { provider: 'gemini' as const, apiKey: '' };
  const vectorStore = config.vectorStore ?? { location: 'cloud' as const, qdrantUrl: '', qdrantApiKey: '' };

  // Configured Gemini keys (falls back to the legacy single key).
  const apiKeys: string[] =
    embedding.apiKeys && embedding.apiKeys.length > 0
      ? embedding.apiKeys
      : [embedding.apiKey ?? ''];
  const configuredKeyCount = apiKeys.filter((k) => k.trim()).length;

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

  // Pasting a comma-separated list of keys expands into one row per key,
  // in place of whichever row received the paste.
  const handleKeyPaste = (i: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    const parts = pasted
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (parts.length <= 1) return;
    e.preventDefault();
    const next = [...apiKeys];
    next.splice(i, 1, ...parts);
    setApiKeys(next);
  };

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<QdrantTestResult | null>(null);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === MESSAGE_TYPES.TEST_QDRANT_CONNECTION_RESULT) {
        setIsTesting(false);
        setTestResult({ ok: !!message.ok, detail: message.detail });
        if (message.url && message.url !== vectorStore.qdrantUrl) {
          updateConfig('vectorStore', 'qdrantUrl', message.url);
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [vectorStore.qdrantUrl]);

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

  const hasQdrant = !!vectorStore.qdrantUrl;
  const summary =
    configuredKeyCount === 0
      ? 'No Gemini key set'
      : !hasQdrant
        ? `${configuredKeyCount} Gemini key${configuredKeyCount > 1 ? 's' : ''} · Qdrant not set`
        : `✅ ${configuredKeyCount} Gemini key${configuredKeyCount > 1 ? 's' : ''} · Qdrant configured`;

  return (
    <SectionShell
      storageKey='remote-engine'
      title='Remote Engine'
      summary={summary}
      needsAttention={configuredKeyCount === 0 || !hasQdrant}
    >
      <div className='settings-form'>
        <div className='form-group'>
          <details className='dep-details' open={configuredKeyCount === 0}>
            <summary>Gemini API Key(s) · {configuredKeyCount} configured</summary>
            <div className='dep-details-body'>
              {apiKeys.map((key, i) => (
                <div key={i} className='api-key-row'>
                  <input
                    id={i === 0 ? 'remote-gemini-api-key' : undefined}
                    type='password'
                    value={key}
                    onChange={(e) => updateApiKeyAt(i, e.target.value)}
                    onPaste={(e) => handleKeyPaste(i, e)}
                    placeholder={i === 0 ? 'Enter your Google Gemini API key' : `Fallback key #${i + 1}`}
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
                Used for embeddings and — behind the scenes — for chat and code generation.
                Extra keys are tried in order if one is rate-limited (HTTP 429). Paste a
                comma-separated list into any field to add them all at once.
              </small>
            </div>
          </details>
        </div>

        <div className='form-group'>
          <label htmlFor='remote-qdrant-url'>Qdrant URL</label>
          <input
            id='remote-qdrant-url'
            type='text'
            value={vectorStore.qdrantUrl ?? ''}
            onChange={(e) => updateConfig('vectorStore', 'qdrantUrl', e.target.value)}
            onBlur={normalizeUrlOnBlur}
            placeholder='https://your-cluster.qdrant.io:6333'
          />
          <small className='form-text'>
            Use the cluster endpoint with port <code>:6333</code> — the dashboard shows it
            without the port. It's added automatically for Qdrant Cloud URLs.
          </small>
        </div>
        <div className='form-group'>
          <label htmlFor='remote-qdrant-api-key'>Qdrant API Key</label>
          <input
            id='remote-qdrant-api-key'
            type='password'
            value={vectorStore.qdrantApiKey ?? ''}
            onChange={(e) => updateConfig('vectorStore', 'qdrantApiKey', e.target.value)}
            placeholder='Enter your Qdrant API key'
          />
        </div>
        <div className='form-group'>
          <button onClick={testConnection} disabled={isTesting || !vectorStore.qdrantUrl}>
            {isTesting ? '⏳ Testing…' : '🔌 Test connection'}
          </button>
          {testResult && (
            <div className={`status-message ${testResult.ok ? 'success' : 'error'}`} style={{ marginTop: '8px' }}>
              {testResult.ok ? '✅ ' : '❌ '}
              {testResult.detail}
            </div>
          )}
        </div>

        <small className='form-text'>
          Chat and code-generation models are managed by WorkspaceGPT — there's nothing to
          configure here.
        </small>
      </div>
    </SectionShell>
  );
};

export default RemoteEngineSettings;
