import React from 'react';
import { useSettingsStore } from '../store';
import { KNOWLEDGE_SOURCES, prepareToConnect } from './settings/knowledgeSources';
import { formatRelativeTime } from './settings/utils';
import StatusDot from './settings/StatusDot';

interface KnowledgeLineProps {
  /** Opens Settings on the given page: a source id, or 'knowledge' for the overview. */
  onOpen: (page: string) => void;
}

/**
 * The greeting's second line on the desktop: what the agent knows right now.
 * The generic subtitle claimed "knows your whole org"; this is the evidence,
 * one organisation source per item, and the nudge when one is missing. It
 * reads from the same registry as Settings → Knowledge, so the two agree.
 *
 * Only the organisation's own systems appear. Web Search is a supplement,
 * not knowledge of the org, and stays in Settings.
 */
const KnowledgeLine: React.FC<KnowledgeLineProps> = ({ onOpen }) => {
  const { config } = useSettingsStore();
  const rows = KNOWLEDGE_SOURCES.filter((s) => s.group === 'Your organisation').map((source) => ({
    source,
    status: source.status(config),
    lastSync: source.lastSync?.(config),
  }));
  const nothingConnected = rows.every((r) => r.status.tone !== 'ok');
  // Freshness once, for the most recently synced source, not per item.
  const freshest = rows
    .filter((r) => r.status.tone === 'ok' && r.lastSync)
    .sort((a, b) => new Date(b.lastSync!).getTime() - new Date(a.lastSync!).getTime())[0];

  return (
    <span className={`home-knowledge${nothingConnected ? ' home-knowledge--empty' : ''}`}>
      <button type='button' className='home-knowledge-lead' onClick={() => onOpen('knowledge')}>
        {nothingConnected ? 'Connect your knowledge:' : 'Knows your org through'}
      </button>
      {rows.map(({ source, status }) => {
        const connected = status.tone === 'ok';
        return (
          <button
            type='button'
            key={source.id}
            className={`home-knowledge-source home-knowledge-source--${status.tone ?? 'off'}`}
            onClick={() => {
              prepareToConnect(source.id, config);
              onOpen(source.id);
            }}
            title={`${source.label}: ${status.text}`}
          >
            {status.tone && <StatusDot tone={status.tone} />}
            {source.label}
            {connected && freshest?.source.id === source.id && (
              <span className='home-knowledge-meta'>· {formatRelativeTime(freshest.lastSync)}</span>
            )}
            {!connected && !nothingConnected && (
              <span className='home-knowledge-next'>· {status.action ?? status.text}</span>
            )}
          </button>
        );
      })}
    </span>
  );
};

export default KnowledgeLine;
