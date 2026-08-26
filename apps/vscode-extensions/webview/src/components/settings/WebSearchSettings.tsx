import React from 'react';
import { useSettingsStore } from '../../store';
import SectionShell from './SectionShell';

const WebSearchSettings: React.FC = () => {
  const { config, updateConfig } = useSettingsStore();
  const webSearch = config.webSearch ?? { apiKey: '' };

  // Configured Tavily keys (falls back to the legacy single key).
  const apiKeys: string[] =
    webSearch.apiKeys && webSearch.apiKeys.length > 0
      ? webSearch.apiKeys
      : [webSearch.apiKey ?? ''];
  const configuredKeyCount = apiKeys.filter((k) => k.trim()).length;

  // Persist a new key list, keeping apiKey synced to the first entry — same
  // failover contract as Model/Embedding settings (see apiKeyFailover.ts).
  const setApiKeys = (keys: string[]) => {
    updateConfig('webSearch', 'apiKeys', keys);
    updateConfig('webSearch', 'apiKey', keys[0] ?? '');
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

  const summary = configuredKeyCount > 0 ? `✅ ${configuredKeyCount} key${configuredKeyCount > 1 ? 's' : ''}` : 'Not configured';

  return (
    <SectionShell storageKey='webSearch' title='Web Search' summary={summary}>
      <div className='settings-form'>
        <div className='form-group'>
          <small className='form-text'>
            Lets the agent look up things it can't know from your code or org
            docs — a new library, an unfamiliar API, current release notes —
            mid-task, the same way Cursor and Claude Code do.
          </small>
        </div>

        <div className='form-group'>
          <details className='dep-details'>
            <summary>
              Tavily API Key(s) · {configuredKeyCount} configured
            </summary>
            <div className='dep-details-body'>
              {apiKeys.map((key, i) => (
                <div key={i} className='api-key-row'>
                  <input
                    id={i === 0 ? 'web-search-api-key' : undefined}
                    type='password'
                    value={key}
                    onChange={(e) => updateApiKeyAt(i, e.target.value)}
                    onPaste={(e) => handleKeyPaste(i, e)}
                    placeholder={i === 0 ? 'tvly-...' : `Fallback key #${i + 1}`}
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
                Free at{' '}
                <a href='https://tavily.com' target='_blank' rel='noreferrer'>
                  tavily.com
                </a>{' '}
                — 1,000 searches/month per key, no card required. Extra keys
                are tried in order if one is rate-limited (HTTP 429) — spread
                free-tier quota across several keys the same way Model and
                Embedding settings do. Paste a comma-separated list into any
                field to add them all at once. Without any key, the agent's
                {' '}
                <code>search_web</code> tool reports itself unavailable
                instead of failing the whole task.
              </small>
            </div>
          </details>
        </div>
      </div>
    </SectionShell>
  );
};

export default WebSearchSettings;
