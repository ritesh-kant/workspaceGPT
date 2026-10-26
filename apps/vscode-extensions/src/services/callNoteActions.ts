/**
 * Host side of call summaries and the "From your calls" panel on Your work
 * (webview/src/components/CallActionsPanel.tsx). The pure parts are in
 * callNoteSummary.ts; this wires them to the configured chat model, the
 * tracker and the webview's messages.
 *
 *   webview → host  GET_CALL_ACTIONS             open items + latest summary; also starts summaries that are missing
 *                   SET_CALL_ACTION {noteId, actionId, state}
 *                   SUMMARIZE_CALL_NOTE {id, force?}
 *   host → webview  CALL_ACTIONS {actions, latest, summarizing, error?}
 *                   CALL_SUMMARY {id, summary, summarizing, error?}
 */
import * as vscode from 'vscode';
import { COPILOT_PROVIDER, MESSAGE_TYPES } from '../../constants';
import { getLlmSettings } from '../utils/getLlmSettings';
import { withKeyFailover } from '../utils/apiKeyFailover';
import { normalizeModelId } from '../utils/normalizeModelId';
import { getProviderDefaultHeaders } from '../utils/anthropicHeaders';
import { markUserTurn } from './copilotDirect';
import { getActiveTicketProvider } from './tickets/registry';
import { callNotesDir } from './callNotes';
import { isSummarizing, listOpenActions, notesNeedingSummary, readCallSummary, setActionState, summarizeCallNote, type ActionState, type Complete } from './callNoteSummary';

/** How far back "recent calls" reaches for open items and for summaries still to make. */
const RECENT_DAYS = 14;
/** Summaries made per Home visit; the rest wait for the next one. */
const SWEEP_LIMIT = 3;

const STATES: readonly ActionState[] = ['open', 'done', 'dismissed', 'mine'];

function completer(context: vscode.ExtensionContext): Complete {
  return async (prompt) => {
    const s = getLlmSettings(context);
    if (!s.provider || !s.baseUrl || !s.model) throw new Error('Select a chat model (Settings → Model) to summarize calls.');
    if (s.provider === COPILOT_PROVIDER) markUserTurn();
    const OpenAI = (await import('openai')).default;
    return withKeyFailover(s.apiKeys.length ? s.apiKeys : ['local'], async (apiKey) => {
      const client = new OpenAI({ apiKey: apiKey || 'local', baseURL: s.baseUrl, maxRetries: 4, defaultHeaders: getProviderDefaultHeaders(s.baseUrl, apiKey) });
      const res = await client.chat.completions.create({
        model: normalizeModelId(s.model!),
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        // Room for a thinking model's reasoning as well as the JSON.
        max_tokens: 4096,
      });
      return res.choices[0]?.message?.content?.trim() || '';
    });
  };
}

function ticketState(context: vscode.ExtensionContext) {
  const provider = getActiveTicketProvider(context);
  return provider ? async (id: string) => (await provider.fetchTicket(id, { includeComments: false })).state : undefined;
}

let sweeping = false;

/** Handles a call-summary message; false when the message is not one of them. */
export async function handleCallNoteMessage(
  context: vscode.ExtensionContext,
  data: any,
  reply: (message: unknown) => Promise<unknown>,
  /** A summary may retitle a call: the Sessions panel lists titles. */
  onRetitled: () => void
): Promise<boolean> {
  const dir = callNotesDir(context.globalStorageUri.fsPath);
  const actions = async (extra: { summarizing?: boolean; error?: string } = {}) =>
    reply({ type: MESSAGE_TYPES.CALL_ACTIONS, ...(await listOpenActions(dir, RECENT_DAYS, ticketState(context))), summarizing: false, ...extra });

  if (data?.type === MESSAGE_TYPES.SET_CALL_ACTION) {
    if (typeof data.noteId === 'string' && typeof data.actionId === 'string' && STATES.includes(data.state)) {
      await setActionState(dir, data.noteId, data.actionId, data.state);
    }
    await actions();
    return true;
  }

  if (data?.type === MESSAGE_TYPES.SUMMARIZE_CALL_NOTE) {
    const id = String(data.id ?? '');
    await reply({ type: MESSAGE_TYPES.CALL_SUMMARY, id, summary: (await readCallSummary(dir, id)) ?? null, summarizing: true });
    let error: string | undefined;
    try {
      await summarizeCallNote(dir, id, completer(context), { force: data.force === true });
      onRetitled();
    } catch (err: any) {
      error = String(err?.message ?? err);
    }
    await reply({ type: MESSAGE_TYPES.CALL_SUMMARY, id, summary: (await readCallSummary(dir, id)) ?? null, summarizing: isSummarizing(id), ...(error ? { error } : {}) });
    return true;
  }

  if (data?.type === MESSAGE_TYPES.GET_CALL_ACTIONS) {
    const missing = sweeping ? [] : (await notesNeedingSummary(dir, RECENT_DAYS)).slice(0, SWEEP_LIMIT);
    await actions({ summarizing: missing.length > 0 });
    if (!missing.length) return true;
    sweeping = true;
    let error: string | undefined;
    try {
      for (const note of missing) {
        await summarizeCallNote(dir, note.id, completer(context));
        onRetitled();
        await actions({ summarizing: note !== missing[missing.length - 1] });
      }
    } catch (err: any) {
      // No model chosen, or the provider failed: the panel says so; the notes stay unsummarized for a later visit.
      error = String(err?.message ?? err);
      await actions({ error });
    } finally {
      sweeping = false;
    }
    return true;
  }
  return false;
}
