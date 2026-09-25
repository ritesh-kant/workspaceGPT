import React from 'react';
import { useSettingsStore, type SettingsConfig } from '../../store/settingsStore';
import ConfluenceSettings from './ConfluenceSettings';
import AdoSettings from './AdoSettings';
import JiraSettings from './JiraSettings';
import WebSearchSettings from './WebSearchSettings';
import StatusDot from './StatusDot';
import { formatRelativeTime } from './utils';

/**
 * The knowledge sources (desktop Settings → Knowledge).
 *
 * WorkspaceGPT answers from the organisation's own systems; these are the
 * product, not optional extras, so every source is listed here and in the nav
 * whether or not it is connected yet, with "Connect" as the call to action.
 * Each entry says what the source is, how to read its state from the settings
 * config, and which settings component is its page.
 *
 * `status` is the one place a source's state is judged. The Knowledge
 * overview, the greeting line on the home screen and the composer's Context
 * menu all read it, so they can never disagree about whether a source is
 * connected, mid-sync, or ready to answer from. Only facts the config already
 * holds go into it.
 */

export type SourceGroup = 'Your organisation' | 'Beyond your organisation';

export interface SourceStatus {
  /** ok: answers can be grounded in it. warn: something still to do or in flight. */
  tone?: 'ok' | 'warn';
  /** The state, in a few words: "Not connected", "Indexing… 40%", "marsaoh · D2C · synced 2h ago". */
  text: string;
  /** The next step, when there is one to take; absent while the source is busy. */
  action?: string;
  /** Answers can be grounded in it right now (connected, scoped, and indexed at least once). */
  ready: boolean;
  /** 0–100 while a sync or an index run is in flight. */
  progress?: number;
}

export interface KnowledgeSource {
  id: string;
  label: string;
  description: string;
  group: SourceGroup;
  icon: React.ReactNode;
  status: (config: SettingsConfig) => SourceStatus;
  /** ISO time of the last completed sync, for freshness displays. */
  lastSync?: (config: SettingsConfig) => string | undefined;
  render: () => React.ReactNode;
  /**
   * Switches the source on. Its page shows the sign-in only while it is on,
   * so a "Connect" that just opened the page would land on an Off toggle.
   */
  turnOn?: () => void;
}

/* Monochrome glyphs, drawn in currentColor; a brand mark would need its own
   colours per theme and a licence check for each. */
const glyph = (path: string) => (
  <svg viewBox='0 0 24 24' width='18' height='18' fill='none' aria-hidden='true'>
    {/* eslint-disable-next-line react/no-danger */}
    <g dangerouslySetInnerHTML={{ __html: path }} />
  </svg>
);

const ICONS = {
  confluence: glyph(
    '<path d="M4 17.5c2.2-3.6 4.2-5 7-3.6l4.6 2.3" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M20 6.5c-2.2 3.6-4.2 5-7 3.6L8.4 7.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'
  ),
  ado: glyph(
    '<path d="M3 8.5l4-1.2v9.4L3 15.5v-7zM7 7.3L15.5 4v16L7 16.7" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M15.5 6.2L21 8v8l-5.5 1.8" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>'
  ),
  jira: glyph(
    '<path d="M12 3l4.5 4.5L12 12 7.5 7.5 12 3z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 12l4.5 4.5L12 21l-4.5-4.5L12 12z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>'
  ),
  webSearch: glyph(
    '<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.7"/><path d="M3.5 12h17M12 3.5c2.8 2.6 4 5.4 4 8.5s-1.2 5.9-4 8.5c-2.8-2.6-4-5.4-4-8.5s1.2-5.9 4-8.5z" stroke="currentColor" stroke-width="1.5"/>'
  ),
};

/** The sync/index lifecycle fields the three synced sources share. */
interface SyncedSourceConfig {
  isAuthenticated?: boolean;
  isSyncing?: boolean;
  isIndexing?: boolean;
  isIndexingCompleted?: boolean;
  canResume?: boolean;
  canResumeIndexing?: boolean;
  lastSyncTime?: string;
}

const pct = (n: number | undefined) => Math.max(0, Math.min(100, Math.round(n || 0)));

/**
 * One judgement for Confluence, Azure DevOps and Jira, in the order the
 * user has to work through it: connect, choose a scope, let the first sync
 * and index finish. Once indexed, a re-sync in flight keeps the source
 * usable (the index still stands), so it stays `ready` and shows progress.
 */
function syncedStatus(
  enabled: boolean,
  s: SyncedSourceConfig | undefined,
  scope: string | undefined,
  scopeNoun: 'space' | 'project',
  syncProgress: number | undefined,
  indexProgress: number | undefined,
  readyText: string
): SourceStatus {
  if (!enabled || !s?.isAuthenticated) return { tone: 'warn', text: 'Not connected', action: 'Connect', ready: false };
  if (!scope) return { tone: 'warn', text: `Connected · no ${scopeNoun} selected`, action: `Choose ${scopeNoun}`, ready: false };
  const indexed = !!s.isIndexingCompleted;
  if (s.isSyncing) {
    const progress = pct(syncProgress);
    return { tone: indexed ? 'ok' : 'warn', text: `Syncing… ${progress}%`, ready: indexed, progress };
  }
  if (s.isIndexing) {
    const progress = pct(indexProgress);
    return { tone: indexed ? 'ok' : 'warn', text: `Indexing… ${progress}%`, ready: indexed, progress };
  }
  if (!indexed) {
    if (s.canResume || s.canResumeIndexing) return { tone: 'warn', text: 'Paused', action: 'Resume the sync', ready: false };
    if (s.lastSyncTime) return { tone: 'warn', text: 'Indexing unfinished', action: 'Finish the sync', ready: false };
    return { tone: 'warn', text: 'Not synced yet', action: 'Start the sync', ready: false };
  }
  return { tone: 'ok', text: readyText, action: 'Manage', ready: true };
}

export const KNOWLEDGE_SOURCES: KnowledgeSource[] = [
  {
    id: 'confluence',
    label: 'Confluence',
    description: 'Your team’s documentation: runbooks, decisions, release notes. Answers cite the pages they come from.',
    group: 'Your organisation',
    icon: ICONS.confluence,
    status: (c) => {
      const s = c.confluence;
      return syncedStatus(
        !!s?.isConfluenceEnabled,
        s,
        s?.spaceKey,
        'space',
        s?.confluenceSyncProgress,
        s?.confluenceIndexProgress,
        `${s?.siteName || 'Connected'} · ${s?.spaceKey} · ${formatRelativeTime(s?.lastSyncTime)}`
      );
    },
    lastSync: (c) => c.confluence?.lastSyncTime,
    render: () => <ConfluenceSettings />,
    turnOn: () => {
      const { config, updateConfig } = useSettingsStore.getState();
      if (!config.confluence?.isConfluenceEnabled) updateConfig('confluence', 'isConfluenceEnabled', true);
    },
  },
  {
    id: 'ado',
    label: 'Azure DevOps',
    description: 'Work items from your project: what is in flight, who owns it, and the tickets behind Your work on the home screen.',
    group: 'Your organisation',
    icon: ICONS.ado,
    status: (c) => {
      const s = c.ado;
      return syncedStatus(
        !!s?.isAdoEnabled,
        s,
        s?.projectName,
        'project',
        s?.adoSyncProgress,
        s?.adoIndexProgress,
        `${s?.orgName ? `${s.orgName} · ` : ''}${s?.projectName} · ${formatRelativeTime(s?.lastSyncTime)}`
      );
    },
    lastSync: (c) => c.ado?.lastSyncTime,
    render: () => <AdoSettings />,
    turnOn: () => {
      const { config, updateConfig } = useSettingsStore.getState();
      if (!config.ado?.isAdoEnabled) updateConfig('ado', 'isAdoEnabled', true);
    },
  },
  {
    id: 'jira',
    label: 'Jira',
    description: 'Issues from your Jira project, so the agent can read the ticket it is working on and find related ones.',
    group: 'Your organisation',
    icon: ICONS.jira,
    status: (c) => {
      const s = c.jira;
      return syncedStatus(
        !!s?.isJiraEnabled,
        s,
        s?.projectName,
        'project',
        s?.jiraSyncProgress,
        s?.jiraIndexProgress,
        `${s?.projectName} · ${formatRelativeTime(s?.lastSyncTime)}`
      );
    },
    lastSync: (c) => c.jira?.lastSyncTime,
    render: () => <JiraSettings />,
    turnOn: () => {
      const { config, updateConfig } = useSettingsStore.getState();
      if (!config.jira?.isJiraEnabled) updateConfig('jira', 'isJiraEnabled', true);
    },
  },
  {
    id: 'webSearch',
    label: 'Web Search',
    description: 'For what your own systems cannot answer: a new library, an unfamiliar API, current release notes.',
    group: 'Beyond your organisation',
    icon: ICONS.webSearch,
    status: (c) => {
      const n = c.webSearch?.apiKeys?.filter((k) => k.trim()).length ?? 0;
      return n > 0
        ? { tone: 'ok', text: `On · ${n} API key${n > 1 ? 's' : ''}`, action: 'Manage', ready: true }
        : { text: 'Off · needs a Tavily API key', action: 'Add key', ready: false };
    },
    render: () => <WebSearchSettings />,
  },
];

export const SOURCE_GROUPS: SourceGroup[] = ['Your organisation', 'Beyond your organisation'];

/** For a click on a source's "Connect": turn it on, so its page opens on the sign-in. */
export function prepareToConnect(id: string, config: SettingsConfig): void {
  const source = KNOWLEDGE_SOURCES.find((s) => s.id === id);
  if (source?.status(config).action === 'Connect') source.turnOn?.();
}

interface OverviewProps {
  config: SettingsConfig;
  onOpen: (id: string) => void;
}

/** The Knowledge page: one card per group, one row per source. */
export const KnowledgeSourcesOverview: React.FC<OverviewProps> = ({ config, onOpen }) => (
  <>
    {SOURCE_GROUPS.map((group) => (
      <section className='sources-group' key={group}>
        <h3 className='sources-group-title'>{group}</h3>
        <div className='sources-list'>
          {KNOWLEDGE_SOURCES.filter((i) => i.group === group).map((item) => {
            const status = item.status(config);
            return (
              <div className='source-row' key={item.id}>
                <span className='source-icon'>{item.icon}</span>
                <button type='button' className='source-main' onClick={() => onOpen(item.id)}>
                  <span className='source-name'>{item.label}</span>
                  <span className='source-desc'>{item.description}</span>
                  <span className='source-status'>
                    {status.tone && <StatusDot tone={status.tone} />}
                    {status.text}
                  </span>
                </button>
                <button
                  type='button'
                  className={`source-action${status.ready ? ' source-action--quiet' : ''}`}
                  onClick={() => {
                    prepareToConnect(item.id, config);
                    onOpen(item.id);
                  }}
                >
                  {status.action ?? 'View'}
                  <span aria-hidden='true'> ›</span>
                </button>
              </div>
            );
          })}
        </div>
      </section>
    ))}
  </>
);
