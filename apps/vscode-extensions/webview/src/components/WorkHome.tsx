import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MESSAGE_TYPES } from '../constants';
import { VSCodeAPI } from '../vscode';
import { useSettingsStore } from '../store';
import { prepareToConnect } from './settings/knowledgeSources';
import type { WorkItemSummary } from './MyWorkPanel';
import { HOME_ACTIVITY_MESSAGES } from '../../../src/services/home/types';
import type { HomeActivity, HomeMention, HomePullRequest } from '../../../src/services/home/types';
import './WorkHome.css';

interface Props {
  items: WorkItemSummary[];
  currentSprintName?: string;
  isLoading: boolean;
  error?: string;
  isRefreshing: boolean;
  onRefresh: () => void;
  onStart: (item: WorkItemSummary) => void;
  sessionForTicket: (item: WorkItemSummary) => string | undefined;
  onResume: (sessionId: string) => void;
  onPrompt: (prompt: string) => void;
  onOpenSettings: (page: string) => void;
  defaultFolderName?: string;
  onOpenDefaultFolder: () => void;
}
type Tab = 'tickets' | 'prs' | 'mentions';
type Entry = { kind: 'ticket'; item: WorkItemSummary } | { kind: 'pr'; item: HomePullRequest } | { kind: 'mention'; item: HomeMention };
const sourceNames = { ado: 'Azure DevOps', jira: 'Jira', confluence: 'Confluence', github: 'GitHub' };
const prStates = { 'review-requested': 'Review requested', 'awaiting-review': 'Awaiting review', 'changes-requested': 'Changes requested', approved: 'Approved', draft: 'Draft' };
const initialActivity: HomeActivity = { pullRequests: { items: [] }, trackerMentions: { items: [] }, confluenceMentions: { items: [] } };

function readLayout(): 'board' | 'inbox' {
  try { return localStorage.getItem('workspacegpt.homeLayout') === 'inbox' ? 'inbox' : 'board'; } catch { return 'board'; }
}
function relativeTime(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes)) return '';
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}

/** Full lists use pagination in a separate dialog, never expand the homepage. */
function HomeDialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, textarea') ?? []);
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [onClose]);
  return createPortal(<div className='work-home-backdrop' onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className='work-home-dialog' role='dialog' aria-modal='true' aria-labelledby='work-home-dialog-title' ref={ref}>
      <header><h2 id='work-home-dialog-title'>{title}</h2><button type='button' aria-label='Close' onClick={onClose}>×</button></header>
      {children}
    </div>
  </div>, document.body);
}

/** Desktop overview: bounded rows sized to the available space, rather than a scrolling feed. */
export default function WorkHome(props: Props) {
  const { config } = useSettingsStore();
  const ado = !!(config.ado?.isAdoEnabled && config.ado.isAuthenticated && config.ado.orgName && config.ado.projectName);
  const jira = !ado && !!(config.jira?.isJiraEnabled && config.jira.isAuthenticated && config.jira.siteUrl && config.jira.projectKey);
  const tracker = ado ? 'ado' : jira ? 'jira' : undefined;
  const confluence = !!(config.confluence?.isConfluenceEnabled && config.confluence.isAuthenticated);
  const identityScope = JSON.stringify([tracker, config.ado?.orgName, config.ado?.projectName, config.ado?.userDisplayName,
    config.jira?.siteUrl, config.jira?.projectKey, config.jira?.accountId, confluence, config.confluence?.cloudId, config.confluence?.spaceKey]);
  const [layout, setLayout] = useState(readLayout);
  const [prTab, setPrTab] = useState<'review' | 'mine'>('review');
  const [filter, setFilter] = useState<Tab | 'all'>('all');
  const [activity, setActivity] = useState<HomeActivity>(initialActivity);
  const [pending, setPending] = useState<string[]>([]);
  const [seen, setSeen] = useState<Record<string, string>>({});
  // Snapshot at entry: reading a mention clears its badge but doesn't make the row jump away.
  const [seenAtEntry, setSeenAtEntry] = useState<Record<string, string>>({});
  const entryLoaded = useRef(false);
  const requestId = useRef('');
  const lastRefresh = useRef(0);
  const [updatedAt, setUpdatedAt] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const overview = useRef<HTMLDivElement>(null);
  const [showTip, setShowTip] = useState(false);
  const [size, setSize] = useState({ height: 360, width: 900 });
  const [dialog, setDialog] = useState<Tab | 'connect' | 'github' | WorkItemSummary | null>(null);
  const [page, setPage] = useState(0);
  const [showRead, setShowRead] = useState(false);
  const [feedError, setFeedError] = useState('');

  const refreshActivity = () => {
    lastRefresh.current = Date.now();
    requestId.current = `${Date.now()}-${Math.random()}`;
    setPending(['pullRequests', 'trackerMentions', 'confluenceMentions']);
    setFeedError('');
    VSCodeAPI().postMessage({ type: HOME_ACTIVITY_MESSAGES.get, requestId: requestId.current });
  };
  useEffect(() => {
    setActivity(initialActivity); setSeen({}); setSeenAtEntry({}); entryLoaded.current = false;
    const receive = (event: MessageEvent) => {
      const m = event.data;
      if (m?.type !== HOME_ACTIVITY_MESSAGES.response || m.requestId !== requestId.current) return;
      if (!entryLoaded.current) { entryLoaded.current = true; setSeenAtEntry(m.seen ?? {}); setSeen(m.seen ?? {}); }
      if (m.section && m.section in initialActivity) {
        const key = m.section as keyof HomeActivity;
        setActivity((previous) => ({ ...previous, [key]: m.value.error && !m.value.items.length && previous[key].items.length
          ? { ...previous[key], error: m.value.error } : m.value }));
        setPending((previous) => previous.filter((section) => section !== key));
      }
      if (m.complete) { setPending([]); setUpdatedAt(new Date().toISOString()); setFeedError(m.error ?? ''); }
    };
    window.addEventListener('message', receive);
    refreshActivity();
    const refreshOnFocus = () => { if (!document.hidden && Date.now() - lastRefresh.current > 2 * 60_000) refreshActivity(); };
    window.addEventListener('focus', refreshOnFocus);
    const timer = window.setInterval(() => { if (!document.hidden) refreshActivity(); }, 5 * 60_000);
    return () => { window.removeEventListener('message', receive); window.removeEventListener('focus', refreshOnFocus); clearInterval(timer); requestId.current = ''; };
    // Identity changes invalidate both lists and read state before new requests.
  }, [identityScope]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ height: entry.contentRect.height, width: entry.contentRect.width }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // A timeout also covers host reload/disposal while a request is in flight.
  useEffect(() => {
    if (!pending.length) return;
    const timeout = window.setTimeout(() => { setPending([]); setFeedError('Activity refresh timed out. Try again.'); }, 120_000);
    return () => clearTimeout(timeout);
  }, [pending.length]);

  const ticketId = (item: WorkItemSummary) => `ticket:${identityScope}:${item.id}`;
  const ticketRevision = (item: WorkItemSummary) => item.changedDate ?? `${item.state}:${item.title}`;
  const mark = (id: string, revision: string | null) => {
    setSeen((previous) => { const next = { ...previous }; if (revision === null) delete next[id]; else next[id] = revision; return next; });
    if (revision === null) setSeenAtEntry((previous) => { const next = { ...previous }; delete next[id]; return next; });
    VSCodeAPI().postMessage({ type: HOME_ACTIVITY_MESSAGES.seen, id, revision });
  };
  const openUrl = (item: HomeMention | HomePullRequest) => {
    mark(item.id, item.revision);
    VSCodeAPI().postMessage({ type: MESSAGE_TYPES.OPEN_EXTERNAL, url: item.url });
  };
  const connect = (id: 'ado' | 'jira' | 'confluence') => { prepareToConnect(id, config); setDialog(null); props.onOpenSettings(id); };
  const openList = (tab: Tab) => { setPage(0); setShowRead(false); setDialog(tab); };
  const ticketItems = tracker ? props.items : [];
  const prs = activity.pullRequests.items.filter((pr) => pr.ownership === prTab);
  const allMentions = useMemo(() => [...activity.trackerMentions.items, ...activity.confluenceMentions.items]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [activity.trackerMentions.items, activity.confluenceMentions.items]);
  const homeMentions = allMentions.filter((item) => seenAtEntry[item.id] !== item.revision);
  const unreadMentions = allMentions.filter((item) => seen[item.id] !== item.revision).length;
  const short = size.height < 500;
  const hasActivityError = !!(props.error || activity.pullRequests.error || activity.trackerMentions.error || activity.confluenceMentions.error);
  const narrow = size.width < 650 || size.height < 400 || (hasActivityError && size.height < 540);
  useEffect(() => { if (narrow && layout === 'board' && filter === 'all') setFilter('tickets'); }, [narrow, layout, filter]);
  const ticketLimit = Math.max(1, Math.min(3, Math.floor((size.height - (narrow ? 185 : 145)) / 74)));
  const prLimit = size.height < 600 ? 1 : 2;
  const inboxLimit = Math.max(1, Math.min(5, Math.floor((size.height - 185) / 72)));
  const pageSize = Math.max(1, Math.min(7, Math.floor((window.innerHeight - 230) / 80)));
  useEffect(() => {
    const element = overview.current;
    if (!element) return;
    const bottom = Math.max(element.getBoundingClientRect().top, ...Array.from(element.children)
      .filter((child) => !child.classList.contains('work-home-tip'))
      .map((child) => child.getBoundingClientRect().bottom));
    setShowTip(!narrow && element.getBoundingClientRect().bottom - bottom >= 80);
  }, [size.height, size.width, layout, filter, prTab, activity, ticketItems.length, homeMentions.length, pending.length, props.error, narrow]);
  const badge = (id: string, revision: string) => seen[id] !== revision && <span className='work-home-new' title='New activity since you last viewed this item' aria-label='New activity' />;
  const start = (item: WorkItemSummary) => { mark(ticketId(item), ticketRevision(item)); setDialog(null); props.onStart(item); };
  const startOrResume = (item: WorkItemSummary) => {
    const sessionId = props.sessionForTicket(item);
    if (!sessionId) return start(item);
    mark(ticketId(item), ticketRevision(item)); setDialog(null); props.onResume(sessionId);
  };
  const review = (pr: HomePullRequest) => {
    mark(pr.id, pr.revision); setDialog(null);
    props.onPrompt(pr.state === 'changes-requested' && pr.ownership === 'mine'
      ? `Read the review feedback on ${pr.url} (${pr.title}) and address the requested changes in ${pr.repository}. Run relevant checks and show the resulting diff. If you cannot access the PR, explain what access is needed.`
      : `Review pull request ${pr.url} (${pr.title}) in ${pr.repository}. Read the diff and linked ticket or design Knowledge, then identify actionable issues with file and line references. Do not edit code, submit a review, or change the PR. If you cannot access the PR, explain what access is needed.`);
  };

  const ticketRow = (item: WorkItemSummary) => <article className='work-home-row' key={ticketId(item)}>
    <div className='work-home-row-body'><button className='work-home-row-title' type='button' onClick={() => { mark(ticketId(item), ticketRevision(item)); setDialog(item); }}>
      {badge(ticketId(item), ticketRevision(item))}<span>{item.title}</span>
    </button><div className='work-home-meta'>{tracker === 'jira' ? 'Jira' : 'ADO'} {item.id} · {item.state}{item.sprint && ` · ${item.sprint}`}</div></div>
    <button className='work-home-action' type='button' onClick={() => startOrResume(item)} title={props.sessionForTicket(item) ? 'Open the existing ticket session' : 'Read the ticket and Knowledge, implement, and verify autonomously'}>{props.sessionForTicket(item) ? 'Continue →' : 'Start work →'}</button>
  </article>;
  const prRow = (pr: HomePullRequest) => <article className='work-home-row work-home-row--pr' key={pr.id}>
    <div className='work-home-row-body'><button className='work-home-row-title' type='button' onClick={() => openUrl(pr)}>{badge(pr.id, pr.revision)}<span>{pr.title}</span></button>
      <div className='work-home-meta'>{pr.source === 'ado' ? 'ADO' : 'GitHub'} #{pr.number} · {pr.author}{pr.updatedAt && ` · ${relativeTime(pr.updatedAt)}`}</div>
      <div className='work-home-pr-status'>{prStates[pr.state]} · {pr.repository}</div></div>
    <div className='work-home-row-actions'>{(pr.ownership === 'review' || pr.state === 'changes-requested') && <button className='work-home-link' type='button' onClick={() => review(pr)}>{pr.ownership === 'mine' ? 'Address feedback' : 'Review with agent'}</button>}<button className='work-home-link' type='button' onClick={() => openUrl(pr)}>View PR ↗</button></div>
  </article>;
  const mentionRow = (item: HomeMention) => <article className='work-home-row work-home-row--mention' key={item.id}>
    <div className='work-home-row-body'><button className='work-home-row-title' type='button' onClick={() => openUrl(item)}>{badge(item.id, item.revision)}<span>{item.contentType === 'page' ? 'You’re mentioned in this page' : `${item.author} mentioned you`}</span></button>
      <div className='work-home-meta'>{sourceNames[item.source]} · {item.title}{item.updatedAt && ` · ${relativeTime(item.updatedAt)}`}</div>
      {item.excerpt && <div className='work-home-excerpt' title={item.excerpt}>{item.excerpt}</div>}</div>
    <div className='work-home-row-actions'><button className='work-home-link' type='button' onClick={() => openUrl(item)}>Open thread ↗</button><button className='work-home-link' type='button' onClick={() => mark(item.id, seen[item.id] === item.revision ? null : item.revision)}>{seen[item.id] === item.revision ? 'Mark unread' : 'Mark read'}</button></div>
  </article>;
  const skeleton = (rows: number) => <div className='work-home-skeleton' aria-hidden='true'>{Array.from({ length: rows }, (_, i) => <div key={i}><span /><span /></div>)}</div>;
  const sectionHead = (title: string, count: number | undefined, tab: Tab) => <header className='work-home-section-head'><h2>{title}{count !== undefined && <span>{count}</span>}</h2>{count !== undefined && (count > 0 || (tab === 'mentions' && allMentions.length > 0)) && <button className='work-home-link' type='button' onClick={() => openList(tab)}>View all →</button>}{count === undefined && <span className='work-home-meta'>Connect to enable</span>}</header>;
  const ticketSection = <section className='work-home-tickets'>
    {sectionHead('Assigned to you', tracker ? ticketItems.length : undefined, 'tickets')}
    {tracker ? <>
      <div className='work-home-section-subtitle'>{sourceNames[tracker]}{props.currentSprintName && ` · ${props.currentSprintName}`}</div>
      {props.error && <div className='work-home-note' role='status' title={props.error}>{ticketItems.length ? 'Showing saved tickets. ' : ''}{props.error}</div>}
      {props.isLoading && !ticketItems.length ? <p className='work-home-empty' role='status'>Loading your tickets…</p> : !ticketItems.length && !props.error ? <p className='work-home-empty'>Nothing assigned to you right now.</p> : ticketItems.slice(0, ticketLimit).map(ticketRow)}
      {ticketItems.length > ticketLimit && <button className='work-home-link work-home-more' type='button' onClick={() => openList('tickets')}>{ticketItems.length - ticketLimit} more tickets →</button>}
    </> : <>{skeleton(short ? 1 : 2)}<p className='work-home-empty'>See assigned tickets and take them from ticket to draft PR.</p><button className='work-home-link' type='button' onClick={() => setDialog('connect')}>Choose Jira or Azure DevOps →</button></>}
  </section>;
  const prSection = <section className='work-home-prs'>
    {sectionHead('Pull requests', tracker ? activity.pullRequests.items.length : undefined, 'prs')}
    {tracker && <div className='work-home-tabs' role='group' aria-label='Pull request views'>{(['review', 'mine'] as const).map((tab) => <button type='button' key={tab} aria-pressed={prTab === tab} className={prTab === tab ? 'is-active' : ''} onClick={() => setPrTab(tab)}>{tab === 'review' ? 'To review' : 'Your PRs'} · {activity.pullRequests.items.filter((pr) => pr.ownership === tab).length}</button>)}</div>}
    {!tracker ? <>{skeleton(1)}<p className='work-home-empty'>Reviews waiting on you and the status of your PRs.</p><button className='work-home-link' type='button' onClick={() => setDialog('connect')}>Connect your tracker →</button></> : <>
      {pending.includes('pullRequests') && !prs.length ? <p className='work-home-empty' role='status'>Loading PRs…</p> : prs.slice(0, prLimit).map(prRow)}
      {activity.pullRequests.error && <div className='work-home-note' role='status'>{activity.pullRequests.error}{jira && <button className='work-home-link' type='button' onClick={() => setDialog('github')}>Set up GitHub PRs →</button>}</div>}
      {!pending.includes('pullRequests') && !activity.pullRequests.error && !prs.length && <p className='work-home-empty'>{prTab === 'review' ? 'No reviews waiting on you.' : 'No open PRs authored by you.'}</p>}
    </>}
  </section>;
  const mentionsSection = <section className='work-home-mentions'>
    {sectionHead('Mentions', tracker || confluence ? unreadMentions : undefined, 'mentions')}
    {!tracker && !confluence ? <>{skeleton(1)}<p className='work-home-empty'>Know when someone tags you in a page or ticket.</p><button className='work-home-link' type='button' onClick={() => setDialog('connect')}>Connect Knowledge →</button></> : <>
      {homeMentions.slice(0, 1).map(mentionRow)}
      {!homeMentions.length && <p className='work-home-empty' role='status'>{pending.some((p) => p.endsWith('Mentions')) ? 'Looking for recent mentions…' : activity.trackerMentions.error || activity.confluenceMentions.error ? 'Mentions could not be refreshed.' : 'You’re caught up on recent mentions.'}</p>}
      {(activity.trackerMentions.error || activity.confluenceMentions.error) && <div className='work-home-note' title={[activity.trackerMentions.error, activity.confluenceMentions.error].filter(Boolean).join(' ')}>Some mentions could not be refreshed. <button className='work-home-link' type='button' onClick={() => openList('mentions')}>Details</button></div>}
      {homeMentions.length > 1 && <button className='work-home-link work-home-more' type='button' onClick={() => openList('mentions')}>{homeMentions.length - 1} more mentions →</button>}
      {!homeMentions.length && allMentions.length > 0 && <button className='work-home-link' type='button' onClick={() => openList('mentions')}>View read mentions →</button>}
    </>}
  </section>;
  const entries: Entry[] = [
    ...activity.pullRequests.items.filter((pr) => pr.state === 'changes-requested' && pr.ownership === 'mine').map((item): Entry => ({ kind: 'pr', item })),
    ...activity.pullRequests.items.filter((pr) => pr.ownership === 'review').map((item): Entry => ({ kind: 'pr', item })),
    ...homeMentions.map((item): Entry => ({ kind: 'mention', item })),
    ...ticketItems.map((item): Entry => ({ kind: 'ticket', item })),
    ...activity.pullRequests.items.filter((pr) => pr.ownership === 'mine' && pr.state !== 'changes-requested').map((item): Entry => ({ kind: 'pr', item })),
  ].filter((entry) => filter === 'all' || entry.kind === (filter === 'tickets' ? 'ticket' : filter === 'prs' ? 'pr' : 'mention'));
  const renderEntry = (entry: Entry) => entry.kind === 'ticket' ? ticketRow(entry.item) : entry.kind === 'pr' ? prRow(entry.item) : mentionRow(entry.item);
  const listRows = dialog === 'tickets' ? ticketItems.map((item): Entry => ({ kind: 'ticket', item })) : dialog === 'prs' ? prs.map((item): Entry => ({ kind: 'pr', item })) : (showRead ? allMentions : homeMentions).map((item): Entry => ({ kind: 'mention', item }));
  const closeDialog = React.useCallback(() => setDialog(null), []);
  const displayPage = Math.min(page, Math.max(0, Math.ceil(listRows.length / pageSize) - 1));
  const activityErrors = [props.error, activity.pullRequests.error, activity.trackerMentions.error, activity.confluenceMentions.error].filter(Boolean).join(' ');
  const refreshLabel = pending.length ? 'Refreshing…' : feedError || activityErrors ? 'Refresh needs attention' : updatedAt ? `Updated ${relativeTime(updatedAt)}` : '';

  const sourceStatus = (connected: boolean, error: string | undefined, refreshing: boolean) =>
    !connected ? { tone: 'waiting', label: 'Not connected' } : error ? { tone: 'error', label: 'Connected · refresh needs attention' }
      : refreshing ? { tone: 'waiting', label: 'Connected · refreshing' } : { tone: 'connected', label: 'Connected' };
  const confluenceStatus = sourceStatus(confluence, activity.confluenceMentions.error, pending.includes('confluenceMentions'));
  const trackerStatus = sourceStatus(!!tracker, props.error || activity.trackerMentions.error, props.isRefreshing || pending.includes('trackerMentions'));
  const tip = <aside className='work-home-tip'><span>Tip</span>{!tracker ? 'Connect Jira or Azure DevOps to start work directly from your assigned tickets.' : confluence ? 'Ask WorkspaceGPT to explain a ticket using its linked Confluence design pages.' : 'Start work reads the ticket, finds the affected code, and runs relevant checks.'}</aside>;

  return <div className={`work-home work-home--${layout}${narrow ? ' work-home--narrow' : ''}${short ? ' work-home--short' : ''}${size.height < 320 ? ' work-home--tiny' : ''}`} ref={container}>
    <div className='work-home-heading'><h1><span className='work-home-mark' aria-hidden='true'>✦</span>Your work</h1><div className='work-home-heading-actions'><button className='work-home-link work-home-folder' type='button' onClick={props.onOpenDefaultFolder} title='Choose the folder ticket work starts in'>{props.defaultFolderName ?? 'Set default folder'}</button><button className='work-home-refresh' type='button' aria-label='Refresh your work' disabled={props.isRefreshing || pending.length > 0} onClick={() => { props.onRefresh(); refreshActivity(); }}>↻</button><div className='work-home-switch' role='group' aria-label='Homepage layout'>{(['board', 'inbox'] as const).map((value) => <button type='button' key={value} aria-pressed={layout === value} className={layout === value ? 'is-active' : ''} onClick={() => { setLayout(value); try { localStorage.setItem('workspacegpt.homeLayout', value); } catch { /* Session-only preference. */ } }}>{value === 'board' ? 'Board' : 'Inbox'}</button>)}</div></div></div>
    <p className='work-home-intro'>{tracker || confluence ? 'Pick up a ticket. Move a review forward.' : 'Connect your Knowledge to bring your work here.'}</p>
    {(layout === 'inbox' || narrow) && <div className='work-home-filters' role='group' aria-label='Work categories'>{(['all', 'tickets', 'prs', 'mentions'] as const).filter((tab) => !narrow || layout === 'inbox' || tab !== 'all').map((tab) => <button type='button' key={tab} aria-pressed={filter === tab} className={filter === tab ? 'is-active' : ''} onClick={() => setFilter(tab)}>{tab === 'all' ? 'Overview' : tab === 'tickets' ? tracker ? `Tickets · ${ticketItems.length}` : 'Tickets' : tab === 'prs' ? tracker ? `PRs · ${activity.pullRequests.items.length}` : 'PRs' : tracker || confluence ? `Mentions · ${unreadMentions}` : 'Mentions'}</button>)}</div>}
    {layout === 'board' ? <div className='work-home-board' ref={overview}>{(!narrow || filter === 'tickets' || filter === 'all') && ticketSection}{(!narrow || filter === 'prs') && prSection}{(!narrow || filter === 'mentions') && mentionsSection}{showTip && tip}</div> : <div className='work-home-inbox' ref={overview}>{entries.length ? entries.slice(0, inboxLimit).map(renderEntry) : !tracker && !confluence ? <div className='work-home-inbox-setup'>{skeleton(2)}<p className='work-home-empty'>Your tickets, PR reviews, and mentions will appear here.</p><button className='work-home-link' type='button' onClick={() => setDialog('connect')}>Choose your Knowledge sources →</button></div> : <p className='work-home-empty' role='status'>{pending.length ? 'Loading recent work…' : 'No items in this view.'}</p>}{entries.length > inboxLimit && <button className='work-home-link work-home-more' type='button' onClick={() => openList(filter === 'all' ? 'tickets' : filter)}>View {filter === 'all' ? 'all tickets' : `all ${entries.length} items`} →</button>}{showTip && tip}</div>}
    <footer className='work-home-footer'>
      <div className='work-home-sources'>
        <button className='work-home-link' type='button' onClick={() => props.onOpenSettings('knowledge')}>Knowledge</button>
        <button type='button' title={`Confluence: ${confluenceStatus.label}`} aria-label={`Confluence: ${confluenceStatus.label}`} onClick={() => connect('confluence')}><span className={`work-home-connection work-home-connection--${confluenceStatus.tone}`} aria-hidden='true' />Confluence</button>
        <button type='button' title={`${tracker ? sourceNames[tracker] : 'Ticket tracker'}: ${trackerStatus.label}`} aria-label={`${tracker ? sourceNames[tracker] : 'Jira or Azure DevOps'}: ${trackerStatus.label}`} onClick={() => tracker ? props.onOpenSettings(tracker) : setDialog('connect')}><span className={`work-home-connection work-home-connection--${trackerStatus.tone}`} aria-hidden='true' />{tracker ? sourceNames[tracker] : 'Jira or Azure DevOps'}</button>
      </div>
      <span className='work-home-refresh-status' title={feedError || activityErrors}>{refreshLabel}</span>
    </footer>
    {dialog && <HomeDialog title={dialog === 'connect' ? 'Connect Knowledge' : dialog === 'github' ? 'GitHub pull requests' : typeof dialog === 'object' ? dialog.title : dialog === 'tickets' ? 'Assigned to you' : dialog === 'prs' ? 'Pull requests' : 'Mentions'} onClose={closeDialog}>
      {dialog === 'connect' ? <div className='work-home-connect'><p>Choose one ticket tracker. Confluence can be connected alongside it.</p><div className='work-home-connect-options'>{!tracker ? <><button type='button' onClick={() => connect('jira')}>Connect Jira</button><span>or</span><button type='button' onClick={() => connect('ado')}>Connect Azure DevOps</button></> : <button type='button' onClick={() => props.onOpenSettings(tracker)}>{sourceNames[tracker]} settings</button>}</div><button type='button' onClick={() => connect('confluence')}>{confluence ? 'Manage' : 'Connect'} Confluence</button></div>
      : dialog === 'github' ? <div className='work-home-connect'><p>Jira tracks your tickets. Your PRs come from GitHub.</p><p>Install GitHub CLI and sign in with <code>gh auth login</code> using your work account, then refresh. WorkspaceGPT reuses that sign-in to read PRs.</p><button type='button' onClick={() => { closeDialog(); refreshActivity(); }}>Refresh GitHub PRs</button></div>
      : typeof dialog === 'object' ? <div className='work-home-ticket-detail'><div className='work-home-meta'>{sourceNames[tracker ?? 'ado']} · {dialog.id} · {dialog.type} · {dialog.state}{dialog.sprint && ` · ${dialog.sprint}`}</div><p>Read the ticket and linked Knowledge, find the affected code, implement, and run relevant checks.</p><button className='work-home-action' type='button' onClick={() => startOrResume(dialog)}>{props.sessionForTicket(dialog) ? 'Continue existing session →' : 'Start work autonomously →'}</button><button className='work-home-link' type='button' onClick={() => VSCodeAPI().postMessage({ type: MESSAGE_TYPES.OPEN_EXTERNAL, url: dialog.url })}>Open ticket ↗</button></div>
      : <>
        {dialog === 'prs' && <div className='work-home-tabs' role='group' aria-label='Pull request views'>{(['review', 'mine'] as const).map((tab) => <button type='button' key={tab} aria-pressed={prTab === tab} className={prTab === tab ? 'is-active' : ''} onClick={() => { setPrTab(tab); setPage(0); }}>{tab === 'review' ? 'To review' : 'Your PRs'}</button>)}</div>}
        {dialog === 'mentions' && <><label className='work-home-read-toggle'><input type='checkbox' checked={showRead} onChange={(e) => { setShowRead(e.target.checked); setPage(0); }} />Include read mentions</label><p className='work-home-coverage'>{[activity.trackerMentions.coverage, activity.confluenceMentions.coverage].filter(Boolean).join(' · ')}</p>{[activity.trackerMentions.error, activity.confluenceMentions.error].filter(Boolean).map((error) => <p key={error} className='work-home-note'>{error}</p>)}</>}
        {dialog === 'prs' && <p className='work-home-coverage'>{activity.pullRequests.coverage}{activity.pullRequests.limited && ' · More results may exist in the source'}</p>}
        <div className='work-home-dialog-list'>{listRows.slice(displayPage * pageSize, (displayPage + 1) * pageSize).map(renderEntry)}{!listRows.length && <p className='work-home-empty'>No items to show.</p>}</div>
        <div className='work-home-pagination'><button type='button' disabled={displayPage === 0} onClick={() => setPage(displayPage - 1)}>← Previous</button><span>{listRows.length ? `${displayPage * pageSize + 1}–${Math.min((displayPage + 1) * pageSize, listRows.length)} of ${listRows.length}` : '0 items'}</span><button type='button' disabled={(displayPage + 1) * pageSize >= listRows.length} onClick={() => setPage(displayPage + 1)}>Next →</button></div>
      </>}
    </HomeDialog>}
  </div>;
}
