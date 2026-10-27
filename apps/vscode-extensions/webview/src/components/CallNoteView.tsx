import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MESSAGE_TYPES } from '../constants';
import { VSCodeAPI } from '../vscode';
import { useCallDetection } from '../hooks/useCallDetection';
import './CallNoteView.css';

/**
 * One call note, opened from the Sessions panel's "Call notes" group or from
 * the recording indicator (docs/design/call-notes.md). The host reads the file
 * (services/callNotes.ts); while the call is still recorded this asks again
 * every few seconds, so the transcript grows on screen.
 */
interface CallNoteTurn {
  speaker: 'you' | 'others';
  at: number;
  text: string;
}
interface CallNote {
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  status: 'recording' | 'done';
  notice?: string;
  turns: CallNoteTurn[];
}

interface CallSummary {
  status: 'done' | 'skipped';
  tldr?: string;
  decisions: string[];
  actions: { id: string; text: string; owner: 'you' | 'other' | 'unclear'; who?: string; due?: string; dueDate?: string; at?: number; state?: 'done' | 'dismissed' }[];
  highlights?: string[];
  decisionSources?: { text: string; at: number }[];
  processedBy?: string;
  topics: string[];
}

const REFRESH_MS = 4000;

function offset(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function when(note: CallNote): string {
  const start = new Date(note.startedAt);
  const day = start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (!note.endedAt) return `${day} · ${clock(start)} · taking notes`;
  const minutes = Math.max(1, Math.round((note.endedAt - note.startedAt) / 60_000));
  const length = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${day} · ${clock(start)} – ${clock(new Date(note.endedAt))} · ${length}`;
}

interface CallNoteViewProps {
  noteId: string;
  onBack: () => void;
  /** Start a chat about this call. */
  onAsk: (note: { id: string; title: string }) => void;
}

const CallNoteView: React.FC<CallNoteViewProps> = ({ noteId, onBack, onAsk }) => {
  const vscode = VSCodeAPI();
  // undefined: still loading; null: no such note (deleted, or never was).
  const [note, setNote] = useState<CallNote | null | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // undefined: not asked yet; null: none yet.
  const [summary, setSummary] = useState<CallSummary | null | undefined>(undefined);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | undefined>();
  const [tab, setTab] = useState<'overview' | 'transcript'>('overview');
  const [query, setQuery] = useState('');
  const [speaker, setSpeaker] = useState<'all' | 'you' | 'others'>('all');
  const [focusedTurn, setFocusedTurn] = useState<number | null>(null);
  const transcriptRef = useRef<HTMLOListElement>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>();
  const [processor, setProcessor] = useState('your configured model');
  // The desktop's recording state: while this note is the one being recorded, Stop is here
  // (the floating indicator steps aside for this view).
  const { recording: live, stop } = useCallDetection({ control: false });
  const liveHere = live?.noteId === noteId ? live : undefined;

  useEffect(() => {
    setNote(undefined);
    setConfirmDelete(false);
    setSummary(undefined);
    setSummarizing(false);
    setSummaryError(undefined);
    setTab('overview');
    setQuery('');
    setSpeaker('all');
    setFocusedTurn(null);
    setPendingAction(null);
    setActionError(undefined);
    setProcessor('your configured model');
    let loaded = false;
    const onMessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === MESSAGE_TYPES.CALL_NOTE && msg.id === noteId) {
        if (!loaded) setTab(msg.note?.status === 'recording' ? 'transcript' : 'overview');
        loaded = true;
        setNote(msg.note ?? null);
        setProcessor(msg.summaryProcessor || 'your configured model');
        setSummary(msg.summary ?? null);
      } else if (msg?.type === MESSAGE_TYPES.CALL_SUMMARY && msg.id === noteId) {
        if (typeof msg.title === 'string') setNote((current) => current ? { ...current, title: msg.title } : current);
        setSummary(msg.summary ?? null);
        setSummarizing(!!msg.summarizing);
        setSummaryError(typeof msg.error === 'string' ? msg.error : undefined);
        setPendingAction(null);
        setActionError(msg.actionError);
      }
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: MESSAGE_TYPES.GET_CALL_NOTE, id: noteId });
    return () => window.removeEventListener('message', onMessage);
  }, [noteId]);

  const recording = note?.status === 'recording';
  // Stop pressed: refresh at once so the status line follows.
  useEffect(() => {
    if (!liveHere) vscode.postMessage({ type: MESSAGE_TYPES.GET_CALL_NOTE, id: noteId });
  }, [!!liveHere]);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => vscode.postMessage({ type: MESSAGE_TYPES.GET_CALL_NOTE, id: noteId }), REFRESH_MS);
    return () => clearInterval(timer);
  }, [recording, noteId]);

  const summarize = (force = false) => vscode.postMessage({ type: MESSAGE_TYPES.SUMMARIZE_CALL_NOTE, id: noteId, force });
  // A finished call with something said and no summary yet: make one (once per opening).
  const asked = React.useRef('');
  useEffect(() => {
    if (note?.status !== 'done' || note.turns.length === 0 || summary !== null || asked.current === noteId) return;
    asked.current = noteId;
    summarize();
  }, [note?.status, note?.turns.length, summary, noteId]);
  const updateAction = (id: string, state?: 'done' | 'open' | 'mine' | 'dismissed', dueDate?: string) => {
    setPendingAction(id);
    setActionError(undefined);
    vscode.postMessage({ type: MESSAGE_TYPES.SET_CALL_ACTION, noteId, actionId: id, state, dueDate });
  };
  const turns = useMemo(() => [...(note?.turns ?? [])].sort((a, b) => a.at - b.at), [note?.turns]);
  const matches = useMemo(() => turns.flatMap((turn, i) =>
    (speaker === 'all' || turn.speaker === speaker) && query.trim() && turn.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ? [i] : []
  ), [turns, query, speaker]);
  useEffect(() => {
    if (query.trim() && !matches.includes(focusedTurn ?? -1)) setFocusedTurn(matches[0] ?? null);
  }, [query, speaker, matches, focusedTurn]);
  useEffect(() => {
    if (tab === 'transcript' && focusedTurn !== null) {
      transcriptRef.current?.querySelector<HTMLElement>(`[data-turn="${focusedTurn}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [tab, focusedTurn]);

  const jumpTo = (at: number) => {
    if (!turns.length) return;
    const nearest = turns.reduce((best, turn, i) => Math.abs(turn.at - at) < Math.abs(turns[best].at - at) ? i : best, 0);
    setQuery('');
    setSpeaker('all');
    setFocusedTurn(nearest);
    setTab('transcript');
  };
  const source = (at: number) => <button type='button' className='call-note-link call-note-source' onClick={() => jumpTo(at)} aria-label={`Show transcript at ${offset(at)}`}>{offset(at)} ↗</button>;
  const navigateMatch = (direction: number) => {
    if (!matches.length) return;
    setFocusedTurn(matches[(matches.indexOf(focusedTurn ?? -1) + direction + matches.length) % matches.length]);
  };
  const highlight = (text: string) => {
    const search = query.trim();
    if (!search) return text;
    const lower = text.toLocaleLowerCase();
    const result: React.ReactNode[] = [];
    let from = 0;
    let found: number;
    while ((found = lower.indexOf(search.toLocaleLowerCase(), from)) !== -1) {
      result.push(text.slice(from, found), <mark key={found}>{text.slice(found, found + search.length)}</mark>);
      from = found + search.length;
    }
    return [...result, text.slice(from)];
  };
  const actionGroup = (owner: 'you' | 'other' | 'unclear', title: string) => {
    const actions = summary?.actions.filter((a) => a.owner === owner) ?? [];
    const renderAction = (a: CallSummary['actions'][number]) => (
      <li key={a.id} className={a.state ? 'is-done' : ''}>
        {owner === 'you' && <input type='checkbox' checked={a.state === 'done'} disabled={pendingAction !== null} onChange={() => updateAction(a.id, a.state === 'done' ? 'open' : 'done')} aria-label={`Done: ${a.text}`} />}
        <div className='call-note-action-content'>
          <span>{a.text}</span>
          <small>{owner === 'you' ? 'You' : owner === 'unclear' ? 'No owner confirmed' : a.who || 'Team member'}{a.due && !a.dueDate && ` · due ${a.due}`} {a.at !== undefined && source(a.at)}</small>
          <div className='call-note-action-controls'>
            {a.state ? <button type='button' className='call-note-link' disabled={pendingAction !== null} onClick={() => updateAction(a.id, 'open')}>Reopen</button> : <>
              {owner !== 'you' && <button type='button' className='call-note-link' disabled={pendingAction !== null} onClick={() => updateAction(a.id, 'mine')}>Mine</button>}
              <button type='button' className='call-note-link' disabled={pendingAction !== null} onClick={() => updateAction(a.id, 'dismissed')}>{owner === 'other' ? 'Dismiss' : 'Not mine'}</button>
              <label>Due <input type='date' value={a.dueDate ?? ''} disabled={pendingAction !== null} aria-label={`Due date: ${a.text}`} onChange={(event) => updateAction(a.id, undefined, event.target.value)} /></label>
            </>}
          </div>
        </div>
      </li>
    );
    const pending = actions.filter((a) => !a.state);
    const closed = actions.filter((a) => a.state);
    if (!actions.length && owner !== 'you') return null;
    return <section className='call-note-action-group'>
      <h3>{title} <span>{pending.length}</span></h3>
      {!pending.length && <p className='call-note-muted'>Nothing pending.</p>}
      <ul className='call-note-actions-list'>{pending.map(renderAction)}</ul>
      {closed.length > 0 && <details><summary>Completed / dismissed ({closed.length})</summary><ul className='call-note-actions-list'>{closed.map(renderAction)}</ul></details>}
    </section>;
  };

  const remove = () => {
    vscode.postMessage({ type: MESSAGE_TYPES.DELETE_CALL_NOTE, id: noteId });
    onBack();
  };

  return (
    <div className='call-note-view'>
      <div className='call-note-header'>
        <button type='button' className='call-note-back' onClick={onBack} aria-label='Back to chat' title='Back to chat'>
          <svg width='14' height='14' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
            <path d='M15 6l-6 6 6 6' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
          </svg>
        </button>
        <div className='call-note-heading'>
          <h2>{note?.title ?? 'Call note'}</h2>
          {note && (
            <span className='call-note-when'>
              {recording && <span className='call-note-live' aria-hidden='true' />}
              {when(note)}
            </span>
          )}
        </div>
        {note && (
          <div className='call-note-actions'>
            {liveHere && liveHere.state !== 'finishing' && (
              <button type='button' className='call-note-button call-note-button--stop' onClick={stop}>
                Stop taking notes
              </button>
            )}
            <button
              type='button'
              className='call-note-button call-note-button--primary'
              onClick={() => onAsk({ id: note.id, title: note.title })}
              disabled={note.turns.length === 0}
              title={note.turns.length === 0 ? 'Nothing was transcribed yet' : 'Start a chat that can read this call'}
            >
              Ask about this call
            </button>
            <details className='call-note-more'><summary aria-label='More call options'>•••</summary><div>
            {confirmDelete ? (
              <>
                <button type='button' className='call-note-button call-note-button--danger' onClick={remove}>
                  {recording ? 'Stop and delete' : 'Delete'}
                </button>
                <button type='button' className='call-note-button' onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type='button' className='call-note-button' onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )}
            </div></details>
          </div>
        )}
      </div>

      <div className='call-note-body'>
        {note === undefined ? (
          <p className='call-note-empty'>Loading…</p>
        ) : note === null ? (
          <p className='call-note-empty'>This call note was deleted.</p>
        ) : (
          <>
            {note.notice && <p className='call-note-notice'>{note.notice}</p>}
            {summarizing && !summary?.tldr && <p className='call-note-empty'>Summarizing this call…</p>}
            {summaryError && (
              <p className='call-note-notice'>
                {summaryError}{' '}
                <button type='button' className='call-note-link' onClick={() => summarize(true)}>
                  Try again
                </button>
              </p>
            )}
            <div className='call-note-tabs' role='tablist' aria-label='Call note view' onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const next = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'transcript' : tab === 'overview' ? 'transcript' : 'overview';
                setTab(next);
                document.getElementById(`call-${next}-tab`)?.focus();
              }
            }}>
              <button type='button' role='tab' tabIndex={tab === 'overview' ? 0 : -1} id='call-overview-tab' aria-selected={tab === 'overview'} aria-controls='call-overview-panel' onClick={() => setTab('overview')}>Overview</button>
              <button type='button' role='tab' tabIndex={tab === 'transcript' ? 0 : -1} id='call-transcript-tab' aria-selected={tab === 'transcript'} aria-controls='call-transcript-panel' onClick={() => setTab('transcript')}>Transcript · {note.turns.length} lines</button>
            </div>
            {actionError && <p className='call-note-notice' role='alert'>{actionError}</p>}
            {tab === 'overview' ? (
              <div id='call-overview-panel' role='tabpanel' aria-labelledby='call-overview-tab' className='call-note-overview'>
                {summary?.status === 'done' ? <>
                  <section className='call-note-summary'>
                    {actionGroup('you', 'Your actions')}
                    {(summary.highlights?.length ?? 0) > 0 ? <>
                      <h3>What matters</h3>
                      <ul>{summary.highlights!.slice(0, 3).map((line, i) => <li key={i}>{line}</li>)}</ul>
                      {summary.tldr && <details className='call-note-context'><summary>Read more</summary><p className='call-note-tldr'>{summary.tldr}</p></details>}
                    </> : summary.tldr && <p className='call-note-tldr'>{summary.tldr}</p>}
                    {summary.decisions.length > 0 && <>
                      <h3>Decisions</h3>
                      <ul>{summary.decisions.map((decision, i) => {
                        const evidence = summary.decisionSources?.find((d) => d.text === decision);
                        return <li key={i}>{decision} {evidence && source(evidence.at)}</li>;
                      })}</ul>
                    </>}
                    {actionGroup('other', 'Team actions')}
                    {actionGroup('unclear', 'Unassigned')}
                    <p className='call-note-summary-foot'>Generated from the transcript. Verify details using the source links.{' '}
                      <button type='button' className='call-note-link' onClick={() => summarize(true)} disabled={summarizing}>{summarizing ? 'Regenerating…' : 'Regenerate'}</button>
                    </p>
                  </section>
                </> : <p className='call-note-empty'>
                  {recording ? 'Taking notes. Open Transcript to follow along.' : summarizing ? 'Preparing your overview…' : 'No summary yet.'}
                  {!recording && !summarizing && note.turns.length > 0 && <> <button type='button' className='call-note-link' onClick={() => summarize(true)}>Generate summary</button></>}
                </p>}
              </div>
            ) : (
              <div id='call-transcript-panel' role='tabpanel' aria-labelledby='call-transcript-tab'>
                <div className='call-note-search'>
                  <input type='search' placeholder='Search this transcript…' aria-label='Search transcript' value={query} onChange={(event) => setQuery(event.target.value)} />
                  <select aria-label='Filter transcript by speaker' value={speaker} onChange={(event) => setSpeaker(event.target.value as typeof speaker)}>
                    <option value='all'>Everyone</option><option value='you'>You</option><option value='others'>Others</option>
                  </select>
                  {query.trim() && <>
                    <span role='status'>{matches.length ? `${Math.max(0, matches.indexOf(focusedTurn ?? -1)) + 1} / ${matches.length}` : 'No matches'}</span>
                    <button type='button' className='call-note-button' disabled={!matches.length} aria-label='Previous match' onClick={() => navigateMatch(-1)}>↑</button>
                    <button type='button' className='call-note-button' disabled={!matches.length} aria-label='Next match' onClick={() => navigateMatch(1)}>↓</button>
                  </>}
                </div>
                {!note.turns.length && <p className='call-note-empty'>{recording ? 'Lines appear here as they are transcribed.' : 'Nothing was transcribed in this call.'}</p>}
                <ol className='call-note-transcript' ref={transcriptRef}>
                  {turns.map((turn, i) => (speaker === 'all' || turn.speaker === speaker) && (
                    <li key={i} data-turn={i} className={`call-note-turn call-note-turn--${turn.speaker}${focusedTurn === i ? ' call-note-turn--focused' : ''}`}>
                      <span className='call-note-speaker'>{turn.speaker === 'you' ? 'You' : 'Others'}</span>
                      <span className='call-note-at'>{offset(turn.at)}</span>
                      <p>{highlight(turn.text)}</p>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <p className='call-note-footer'>
              Transcribed locally · Stored locally · {summary?.processedBy ? `Summary processed by ${summary.processedBy}` : `Summaries use ${processor}; transcript text is sent to its endpoint.`}
              <br />“You” is your microphone; “Others” is everyone else on the call. Audio is not retained.
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default CallNoteView;
