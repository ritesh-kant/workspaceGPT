import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MESSAGE_TYPES } from '../constants';
import { VSCodeAPI } from '../vscode';
import { useCallDetection } from '../hooks/useCallDetection';
import { useUiStore } from '../store/uiStore';
import './CallActionsPanel.css';

/**
 * "From your recent calls" on Your work (desktop), under the tickets: what is
 * pending for the user from recent calls, items the calls left unassigned,
 * and what mattered (services/callNoteActions.ts). Nothing when there are no
 * call notes with something in them.
 */
interface Action {
  id: string;
  text: string;
  due?: string;
  dueDate?: string;
  noteId: string;
  noteTitle: string;
  startedAt: number;
}
interface Highlight {
  text: string;
  noteId: string;
  noteTitle: string;
  startedAt: number;
}
interface Data {
  actions: Action[];
  suggested: Action[];
  highlights: Highlight[];
  calls: number;
  newest?: number;
}
const EMPTY: Data = { actions: [], suggested: [], highlights: [], calls: 0 };

/** Fit levels: 4 everything, 3 without "What matters", 2 compact, 1 one line, 0 hidden. Pending rows shown at each. */
const ROWS = [0, 0, 2, 3, 3] as const;
type Level = 0 | 1 | 2 | 3 | 4;

const dayStart = (at: number) => new Date(at).setHours(0, 0, 0, 0);
const dayWord = (at: number): string => {
  const diff = Math.round((dayStart(Date.now()) - dayStart(at)) / 86_400_000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};
const when = (at: number) => `${dayWord(at)}, ${new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;

function dueChip(a: Action): { label: string; tone: 'warn' | 'danger' | 'none' } {
  if (a.dueDate) {
    const [y, m, d] = a.dueDate.split('-').map(Number);
    const days = Math.round((new Date(y, m - 1, d).getTime() - dayStart(Date.now())) / 86_400_000);
    if (days === 0) return { label: 'Due today', tone: 'warn' };
    if (days === 1) return { label: 'Tomorrow', tone: 'warn' };
    if (days < 0) return { label: 'Overdue', tone: 'danger' };
    return { label: `Due ${new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`, tone: 'none' };
  }
  return { label: a.due ? `Due ${a.due}` : 'No due date', tone: 'none' };
}

const CallActionsPanel: React.FC = () => {
  const [data, setData] = useState<Data>(EMPTY);
  const [summarizing, setSummarizing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [all, setAll] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // The panel takes only the room the rest of the board leaves.
  const root = useRef<HTMLElement>(null);
  const [level, setLevel] = useState<Level>(4);
  const [resized, setResized] = useState(0);
  const { outcome } = useCallDetection({ control: false });
  const open = (id: string) => useUiStore.getState().openCallNote(id);
  const ask = () => VSCodeAPI().postMessage({ type: MESSAGE_TYPES.GET_CALL_ACTIONS });

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type !== MESSAGE_TYPES.CALL_ACTIONS) return;
      setData({
        actions: Array.isArray(msg.actions) ? msg.actions : [],
        suggested: Array.isArray(msg.suggested) ? msg.suggested : [],
        highlights: Array.isArray(msg.highlights) ? msg.highlights : [],
        calls: Number(msg.calls) || 0,
        newest: typeof msg.newest === 'number' ? msg.newest : undefined,
      });
      setSummarizing(!!msg.summarizing);
      setError(typeof msg.error === 'string' ? msg.error : undefined);
    };
    window.addEventListener('message', onMessage);
    ask();
    return () => window.removeEventListener('message', onMessage);
  }, []);
  // A call just ended: its note is ready to be summarized.
  useEffect(() => {
    if (outcome?.endedAt) ask();
  }, [outcome?.endedAt]);

  useEffect(() => {
    const board = root.current?.closest('.work-home-board');
    if (!board) return;
    const observer = new ResizeObserver(() => setResized((n) => n + 1));
    observer.observe(board);
    for (const section of Array.from(board.querySelectorAll('section'))) if (section !== root.current) observer.observe(section);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => setLevel(4), [resized, data, summarizing, error, all, reviewing]);
  useLayoutEffect(() => {
    const panel = root.current;
    const board = panel?.closest('.work-home-board');
    if (!panel || !board || level === 0) return;
    if (panel.getBoundingClientRect().bottom > board.getBoundingClientRect().bottom + 1) setLevel((level - 1) as Level);
  });

  const set = (a: Action, state: 'done' | 'dismissed' | 'mine') => {
    setData((d) => ({
      ...d,
      actions: state === 'mine' ? d.actions : d.actions.filter((x) => !(x.noteId === a.noteId && x.id === a.id)),
      suggested: d.suggested.filter((x) => !(x.noteId === a.noteId && x.id === a.id)),
    }));
    VSCodeAPI().postMessage({ type: MESSAGE_TYPES.SET_CALL_ACTION, noteId: a.noteId, actionId: a.id, state });
  };

  const { actions, suggested, highlights, calls } = data;
  const empty = !calls && !actions.length && !suggested.length && !summarizing && !error;
  const shown = all ? actions.length : ROWS[level];
  const newest = highlights[0]?.noteId ?? actions[0]?.noteId ?? suggested[0]?.noteId;
  if (level === 1) {
    return (
      <section ref={root} className='call-actions call-actions--1' aria-label='From your recent calls' hidden={empty}>
        <button type='button' className='call-actions-line' onClick={() => newest && open(newest)}>
          <strong>From your recent calls</strong>
          <span>
            {actions.length} pending{suggested.length > 0 && ` · ${suggested.length} suggested`}
          </span>
          <span className='call-actions-line-open'>Open →</span>
        </button>
      </section>
    );
  }
  return (
    <section ref={root} className={`call-actions call-actions--${level}`} aria-label='From your recent calls' hidden={empty || level === 0}>
      <header>
        <h2>From your recent calls</h2>
        {level >= 3 && <p className='call-actions-sub'>{calls ? `Updated from ${calls} call${calls === 1 ? '' : 's'}${data.newest ? ` · ${dayWord(data.newest).toLowerCase()}` : ''}` : summarizing ? 'Summarizing your recent calls…' : ''}</p>}
      </header>
      {error && (
        <p className='call-actions-muted' role='status'>
          {error}
        </p>
      )}
      <div className='call-actions-block'>
        <div className='call-actions-head'>
          <h3>
            Pending for you<span>{actions.length}</span>
          </h3>
          {actions.length > ROWS[level] && (
            <button type='button' className='work-home-link' onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : 'View all →'}
            </button>
          )}
        </div>
        {actions.length === 0 ? (
          <p className='call-actions-muted'>{summarizing ? 'Looking for action items…' : 'Nothing pending from your recent calls.'}</p>
        ) : (
          <ul>
            {actions.slice(0, shown).map((a) => {
              const chip = dueChip(a);
              return (
                <li key={`${a.noteId}:${a.id}`}>
                  <input type='checkbox' aria-label={`Mark done: ${a.text}`} onChange={() => set(a, 'done')} />
                  <button type='button' className='call-actions-item' onClick={() => open(a.noteId)} title={`${a.text}\nFrom: ${a.noteTitle}`}>
                    <span>{a.text}</span>
                    <small>
                      {a.noteTitle} · {when(a.startedAt)} ↗
                    </small>
                  </button>
                  <span className={`call-actions-chip call-actions-chip--${chip.tone}`}>{chip.label}</span>
                  <button type='button' className='call-actions-dismiss' aria-label='Dismiss' title='Not mine / not needed' onClick={() => set(a, 'dismissed')}>
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {suggested.length > 0 && (
        <div className='call-actions-block call-actions-suggested'>
          <div className='call-actions-head'>
            <h3>
              Suggested for you<span>{suggested.length}</span>
            </h3>
            <button type='button' className='call-actions-review' onClick={() => setReviewing(!reviewing)} aria-expanded={reviewing}>
              {reviewing ? 'Close' : 'Review'}
            </button>
          </div>
          <p className='call-actions-muted'>
            {suggested.length} action{suggested.length === 1 ? '' : 's'} from recent calls {suggested.length === 1 ? 'is' : 'are'} unconfirmed and not added to your tasks.
          </p>
          {reviewing && (
            <ul>
              {suggested.map((a) => (
                <li key={`${a.noteId}:${a.id}`}>
                  <button type='button' className='call-actions-item' onClick={() => open(a.noteId)} title={`From: ${a.noteTitle}`}>
                    <span>{a.text}</span>
                    <small>
                      {a.noteTitle} · {when(a.startedAt)} ↗
                    </small>
                  </button>
                  <button type='button' className='call-actions-review' onClick={() => set(a, 'mine')}>
                    Mine
                  </button>
                  <button type='button' className='call-actions-dismiss call-actions-dismiss--shown' aria-label='Not mine' title='Not mine' onClick={() => set(a, 'dismissed')}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {level === 4 && highlights.length > 0 && (
        <div className='call-actions-block'>
          <div className='call-actions-head'>
            <h3>What matters</h3>
          </div>
          <ul className='call-actions-matters'>
            {highlights.map((h, i) => (
              <li key={i}>
                <span>{h.text}</span>
                <button type='button' className='work-home-link' onClick={() => open(h.noteId)}>
                  {h.noteTitle} ↗
                </button>
              </li>
            ))}
          </ul>
          {newest && (
            <button type='button' className='work-home-link' onClick={() => open(newest)}>
              Browse call notes →
            </button>
          )}
        </div>
      )}
    </section>
  );
};

export default CallActionsPanel;
