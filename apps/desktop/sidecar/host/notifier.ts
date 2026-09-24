/**
 * Tells the user when a run needs them: an approval card is waiting, a
 * question was asked, or the work finished (or failed).
 *
 * Nothing new is decided here. The extension already posts these moments to
 * the chat view as its own messages — AGENT_WRITE_REVIEW (the run is blocked
 * on a decision), RECEIVE_MESSAGE_DONE / ERROR_CHAT (the turn ended), each
 * stamped with its sessionId — and the compat window.show* questions go
 * through the view surface. This module only watches that traffic and hands
 * one "attention" record to the shell, which decides whether the user is
 * already looking (window focused) and posts a native notification if not.
 *
 * Suppressed on purpose: a turn the user stopped (they were there), and the
 * DONE that follows an ERROR_CHAT for the same turn (one notice per ending).
 */
import { MESSAGE_TYPES } from '../../../vscode-extensions/constants';
import type { ViewSurface } from './webviewHost';

export type AttentionKind = 'input' | 'done' | 'failed';

export interface Attention {
  kind: AttentionKind;
  title: string;
  body: string;
  sessionId?: string;
  /** On screen if the window is focused: the chat is showing this session (or it's a sessionless question). */
  visible: boolean;
}

interface SessionTurn {
  /** The user's message that started the turn — the notification's label. */
  prompt: string;
  stopped: boolean;
  failed: boolean;
  filesChanged: number;
}

const LABEL_CHARS = 60;

function label(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > LABEL_CHARS ? `${oneLine.slice(0, LABEL_CHARS - 1)}…` : oneLine;
}

export function watchForAttention(chat: ViewSurface, emit: (a: Attention) => void): void {
  const turns = new Map<string, SessionTurn>();
  let visibleSession: string | undefined;

  const turnFor = (sessionId: string): SessionTurn => {
    let t = turns.get(sessionId);
    if (!t) {
      t = { prompt: '', stopped: false, failed: false, filesChanged: 0 };
      turns.set(sessionId, t);
    }
    return t;
  };
  const send = (kind: AttentionKind, title: string, body: string, sessionId?: string) =>
    // A question with no session is drawn over whichever chat is open.
    emit({ kind, title, body, sessionId, visible: sessionId ? sessionId === visibleSession : true });

  // Page → host: what the user asked, which session is on screen, and stops.
  chat.webview.onDidReceiveMessage((raw: unknown) => {
    const msg = raw as { type?: string; sessionId?: unknown; message?: unknown } | undefined;
    const sessionId = typeof msg?.sessionId === 'string' ? msg.sessionId : undefined;
    if (msg?.type === MESSAGE_TYPES.SESSION_CHANGED) {
      visibleSession = sessionId;
    } else if (msg?.type === MESSAGE_TYPES.SEND_MESSAGE && sessionId) {
      turns.set(sessionId, {
        prompt: typeof msg.message === 'string' ? label(msg.message) : '',
        stopped: false,
        failed: false,
        filesChanged: 0,
      });
    } else if (msg?.type === MESSAGE_TYPES.STOP_MESSAGE && sessionId) {
      turnFor(sessionId).stopped = true;
    }
  });

  // Host → page: the moments worth a notification.
  chat.posted.event((raw: unknown) => {
    const msg = raw as { type?: string; sessionId?: unknown; [k: string]: unknown } | undefined;
    const sessionId = typeof msg?.sessionId === 'string' ? msg.sessionId : undefined;
    if (!msg || !sessionId) return;
    const turn = turnFor(sessionId);
    const about = turn.prompt ? `“${turn.prompt}”` : 'Your chat';
    switch (msg.type) {
      case MESSAGE_TYPES.AGENT_WRITE_REVIEW: {
        const what =
          msg.kind === 'command' && typeof msg.command === 'string'
            ? `Run: ${label(msg.command)}`
            : typeof msg.summary === 'string'
              ? label(msg.summary)
              : 'A change is waiting for your review';
        send('input', 'Approval needed', `${about}\n${what}`, sessionId);
        break;
      }
      case MESSAGE_TYPES.AGENT_TURN_SUMMARY:
        turn.filesChanged = Array.isArray(msg.filesChanged) ? msg.filesChanged.length : 0;
        break;
      case MESSAGE_TYPES.ERROR_CHAT:
        if (turn.stopped || turn.failed) break;
        turn.failed = true;
        send('failed', 'Run stopped with an error', `${about}\n${typeof msg.message === 'string' ? label(msg.message) : ''}`.trim(), sessionId);
        break;
      case MESSAGE_TYPES.RECEIVE_MESSAGE_DONE: {
        if (turn.stopped || turn.failed) break;
        const changed = turn.filesChanged ? ` · ${turn.filesChanged} file${turn.filesChanged === 1 ? '' : 's'} changed` : '';
        send('done', `Done${changed}`, about, sessionId);
        break;
      }
    }
  });

  // Questions the extension asks through window.show* (e.g. "Reconnect?").
  chat.asked.event((question) => send('input', 'WorkspaceGPT needs an answer', label(question)));
}
