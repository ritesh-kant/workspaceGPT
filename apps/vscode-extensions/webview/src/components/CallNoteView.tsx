import React, { useEffect, useState } from 'react';
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
  actions: { id: string; text: string; owner: 'you' | 'other'; who?: string; due?: string; at?: number; state?: 'done' | 'dismissed' }[];
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
  const [showTranscript, setShowTranscript] = useState(false);
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
    setShowTranscript(false);
    const onMessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === MESSAGE_TYPES.CALL_NOTE && msg.id === noteId) {
        setNote(msg.note ?? null);
        setSummary(msg.summary ?? null);
      } else if (msg?.type === MESSAGE_TYPES.CALL_SUMMARY && msg.id === noteId) {
        setSummary(msg.summary ?? null);
        setSummarizing(!!msg.summarizing);
        setSummaryError(typeof msg.error === 'string' ? msg.error : undefined);
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
  const markAction = (id: string, state: 'done' | 'open') => {
    setSummary((s) => (s ? { ...s, actions: s.actions.map((a) => (a.id === id ? { ...a, state: state === 'open' ? undefined : state } : a)) } : s));
    vscode.postMessage({ type: MESSAGE_TYPES.SET_CALL_ACTION, noteId, actionId: id, state });
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
                <button type='button' className='call-note-link' onClick={() => summarize()}>
                  Try again
                </button>
              </p>
            )}
            {summary?.status === 'done' && (
              <section className='call-note-summary'>
                {summary.tldr && <p className='call-note-tldr'>{summary.tldr}</p>}
                {summary.decisions.length > 0 && (
                  <>
                    <h3>Decisions</h3>
                    <ul>
                      {summary.decisions.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  </>
                )}
                {summary.actions.length > 0 && (
                  <>
                    <h3>Action items</h3>
                    <ul className='call-note-actions-list'>
                      {summary.actions.map((a) => (
                        <li key={a.id} className={a.state ? 'is-done' : ''}>
                          {a.owner === 'you' ? (
                            <input type='checkbox' checked={a.state === 'done'} onChange={() => markAction(a.id, a.state === 'done' ? 'open' : 'done')} aria-label={`Done: ${a.text}`} />
                          ) : (
                            <span className='call-note-owner' aria-hidden='true' />
                          )}
                          <span>
                            {a.text}
                            <small>
                              {a.owner === 'you' ? 'You' : a.who || 'Someone else'}
                              {a.due && ` · due ${a.due}`}
                              {a.at !== undefined && ` · ${offset(a.at)}`}
                            </small>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <p className='call-note-summary-foot'>
                  Written by the model from the transcript below; check anything that matters.{' '}
                  <button type='button' className='call-note-link' onClick={() => summarize(true)} disabled={summarizing}>
                    Regenerate
                  </button>
                </p>
              </section>
            )}
            {summary?.status === 'done' && note.turns.length > 0 && (
              <button type='button' className='call-note-link call-note-transcript-toggle' onClick={() => setShowTranscript(!showTranscript)} aria-expanded={showTranscript}>
                {showTranscript ? 'Hide transcript' : `Show transcript (${note.turns.length} lines)`}
              </button>
            )}
            {note.turns.length === 0 ? (
              <p className='call-note-empty'>
                {recording ? 'Taking notes. Lines appear here every few seconds as they are transcribed.' : 'Nothing was transcribed in this call.'}
              </p>
            ) : summary?.status === 'done' && !showTranscript ? null : (
              <ol className='call-note-transcript'>
                {[...note.turns]
                  .sort((a, b) => a.at - b.at)
                  .map((turn, i) => (
                    <li key={i} className={`call-note-turn call-note-turn--${turn.speaker}`}>
                      <span className='call-note-speaker'>{turn.speaker === 'you' ? 'You' : 'Others'}</span>
                      <span className='call-note-at'>{offset(turn.at)}</span>
                      <p>{turn.text}</p>
                    </li>
                  ))}
              </ol>
            )}
            <p className='call-note-footer'>
              Transcribed on this Mac. “You” is your microphone; “Others” is everyone else on the call. Kept only on this machine.
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default CallNoteView;
