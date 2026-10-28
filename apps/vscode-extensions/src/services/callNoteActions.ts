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
import { callNotesDir, isCallNoteId, readCallNote } from './callNotes';
import { isSummarizing, listOpenActions, notesNeedingSummary, readCallSummary, setActionState, summarizeCallNote, type ActionState, type Complete } from './callNoteSummary';

/** How far back highlights and missing-summary generation reach; tasks stay until resolved. */
const RECENT_DAYS = 14;
/** Summaries made per Home visit; the rest wait for the next one. */
const SWEEP_LIMIT = 3;

const STATES: readonly ActionState[] = ['open', 'done', 'dismissed', 'mine'];

export function callSummaryProcessor(context: vscode.ExtensionContext): string {
  const s = getLlmSettings(context);
  return s.provider ? `${s.provider}${s.model ? ` · ${s.model}` : ''}` : 'your configured model';
}

/** One-shot completion on the configured chat model; also used to write commit subjects. */
export function completer(context: vscode.ExtensionContext): Complete {
  const s = getLlmSettings(context);
  return async (prompt) => {
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
    let actionError: string | undefined;
    try {
      if (!isCallNoteId(data.noteId) || typeof data.actionId !== 'string' ||
          !(STATES.includes(data.state) || (data.state === undefined && typeof data.dueDate === 'string'))) {
        throw new Error('Invalid action update.');
      }
      const updated = await setActionState(dir, data.noteId, data.actionId, data.state, typeof data.dueDate === 'string' ? { dueDate: data.dueDate } : {});
      if (!updated) throw new Error('This action is no longer available. Reopen the call note.');
    } catch (err: any) { actionError = String(err?.message ?? err); }
    await reply({ type: MESSAGE_TYPES.CALL_SUMMARY, id: data.noteId, summary: isCallNoteId(data.noteId) ? (await readCallSummary(dir, data.noteId)) ?? null : null, summarizing: isSummarizing(data.noteId), actionError });
    await actions();
    return true;
  }

  if (data?.type === MESSAGE_TYPES.SUMMARIZE_CALL_NOTE) {
    const id = String(data.id ?? '');
    await reply({ type: MESSAGE_TYPES.CALL_SUMMARY, id, summary: (await readCallSummary(dir, id)) ?? null, summarizing: true });
    let error: string | undefined;
    try {
      await summarizeCallNote(dir, id, completer(context), { force: data.force === true, processedBy: callSummaryProcessor(context) });
      onRetitled();
    } catch (err: any) {
      error = String(err?.message ?? err);
    }
    await reply({ type: MESSAGE_TYPES.CALL_SUMMARY, id, summary: (await readCallSummary(dir, id)) ?? null, title: (await readCallNote(dir, id))?.title, summarizing: isSummarizing(id), ...(error ? { error } : {}) });
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
        await summarizeCallNote(dir, note.id, completer(context), { processedBy: callSummaryProcessor(context) });
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
