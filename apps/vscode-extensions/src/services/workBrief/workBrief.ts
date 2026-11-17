/**
 * Stores the work brief on this machine and answers questions from it.
 *
 *   <globalStorage>/work-brief/brief.json   { v, builtAt, user, items, notes, read }
 *
 * Commands (registered in extension.ts):
 *   workspacegpt.askAboutMyWork        input box → answer (VS Code and desktop)
 *   workspacegpt.workBrief.ask (q)     → AskResult   (the desktop icon overlay)
 *   workspacegpt.workBrief.status      → BriefStatus
 *   workspacegpt.workBrief.refresh     rebuild now
 *
 * Privacy: the brief is built from the user's own sources and kept in
 * globalStorage; only the prompt for one question goes to the chosen model,
 * as with any chat. Analytics carry counts and timings, never content.
 */
import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { completer } from '../callNoteActions';
import { answerParts, buildAnswerPrompt, citedSources, dedupe, speakable, type AnswerSource, type WorkItem } from './brief';
import { callWork, fetchMyWork, WINDOW_DAYS } from './fetchMyWork';

/** A brief older than this is rebuilt in the background on the next question. */
const STALE_MS = 6 * 3_600_000;

interface StoredBrief {
  v: 1;
  builtAt: number;
  user?: string;
  items: WorkItem[];
  notes: string[];
  read: string[];
}

export interface BriefStatus {
  state: 'empty' | 'building' | 'ready';
  builtAt?: number;
  windowDays: number;
  counts: Record<string, number>;
  notes: string[];
  error?: string;
}

export interface AskResult {
  ok: boolean;
  answer: string;
  /** The answer without citation brackets, to read aloud. */
  spoken: string;
  sources: AnswerSource[];
  /** The answer for display: text, and numbers that index `sources` where it cites one. */
  parts?: Array<string | number>;
  builtAt?: number;
  ms: number;
}

export class WorkBrief {
  private cached: StoredBrief | undefined;
  private building: Promise<StoredBrief> | undefined;
  private lastError: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get file(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'work-brief', 'brief.json');
  }

  private async load(): Promise<StoredBrief | undefined> {
    if (this.cached) return this.cached;
    try {
      const parsed = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      if (parsed?.v === 1 && Array.isArray(parsed.items)) this.cached = parsed;
    } catch {
      // No brief yet.
    }
    return this.cached;
  }

  /** One build at a time; callers share it. */
  refresh(): Promise<StoredBrief> {
    this.building ??= (async () => {
      try {
        const fetched = await fetchMyWork(this.context);
        if (!fetched.items.length && fetched.notes.length) throw new Error(fetched.notes.join(' · '));
        const brief: StoredBrief = { v: 1, builtAt: Date.now(), ...(fetched.user ? { user: fetched.user } : {}), items: dedupe(fetched.items), notes: fetched.notes, read: fetched.read };
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(brief));
        await fsp.rename(tmp, this.file);
        this.cached = brief;
        this.lastError = undefined;
        return brief;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        this.building = undefined;
      }
    })();
    return this.building;
  }

  async status(): Promise<BriefStatus> {
    const brief = await this.load();
    const counts: Record<string, number> = {};
    for (const item of brief?.items ?? []) counts[item.source] = (counts[item.source] ?? 0) + 1;
    return {
      state: this.building ? 'building' : brief ? 'ready' : 'empty',
      ...(brief ? { builtAt: brief.builtAt } : {}),
      windowDays: WINDOW_DAYS,
      counts,
      notes: brief?.notes ?? [],
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async ask(question: string, history: { q: string; a: string }[] = []): Promise<AskResult> {
    const started = Date.now();
    const q = String(question ?? '').trim().slice(0, 2000);
    if (!q) return { ok: false, answer: 'Ask a question about your work.', spoken: '', sources: [], ms: 0 };
    let brief = await this.load();
    try {
      if (!brief) brief = await this.refresh();
      else if (Date.now() - brief.builtAt > STALE_MS) void this.refresh().catch(() => undefined);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { ok: false, answer: `Could not build your brief: ${why}`, spoken: '', sources: [], ms: Date.now() - started };
    }
    if (!brief.items.length) {
      return { ok: false, answer: 'Your brief is empty. Connect Knowledge (Azure DevOps, Jira or Confluence) in Settings, then refresh.', spoken: '', sources: [], builtAt: brief.builtAt, ms: Date.now() - started };
    }
    // Call notes are local: read them now, so a call that just ended is known without a rebuild.
    const calls = await callWork(this.context).catch(() => undefined);
    const items = calls ? [...brief.items.filter((i) => i.source !== 'call'), ...calls] : brief.items;
    const turns = (Array.isArray(history) ? history : [])
      .filter((t) => typeof t?.q === 'string' && typeof t?.a === 'string')
      .map((t) => ({ q: t.q.slice(0, 2000), a: t.a.slice(0, 4000) }));
    const { prompt, shown } = buildAnswerPrompt({ question: q, items, user: brief.user, builtAt: brief.builtAt, notes: brief.notes, history: turns });
    let answer: string;
    try {
      answer = (await completer(this.context)(prompt)).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { ok: false, answer: /Select a chat model/.test(why) ? 'Select a chat model in Settings → Model to ask about your work.' : `The model did not answer: ${why}`, spoken: '', sources: [], builtAt: brief.builtAt, ms: Date.now() - started };
    }
    const sources = citedSources(answer, items, shown);
    return { ok: !!answer, answer: answer || 'The model returned no answer. Try again.', spoken: speakable(answer), sources, parts: answerParts(answer, items, shown, sources), builtAt: brief.builtAt, ms: Date.now() - started };
  }
}

/** Registers the brief's commands; returns the disposables. */
export function registerWorkBrief(context: vscode.ExtensionContext, track?: (event: string, props: Record<string, unknown>) => void): vscode.Disposable[] {
  const brief = new WorkBrief(context);
  const ask = async (question: string, history?: { q: string; a: string }[]) => {
    const result = await brief.ask(question, history);
    track?.('work_brief_asked', { ok: result.ok, ms: result.ms, sources: result.sources.length, followUp: !!history?.length });
    return result;
  };
  return [
    vscode.commands.registerCommand('workspacegpt.workBrief.ask', (question: string, history?: { q: string; a: string }[]) => ask(question, history)),
    vscode.commands.registerCommand('workspacegpt.workBrief.status', () => brief.status()),
    vscode.commands.registerCommand('workspacegpt.workBrief.refresh', async () => {
      const started = Date.now();
      try {
        const built = await brief.refresh();
        track?.('work_brief_built', { ok: true, items: built.items.length, ms: Date.now() - started });
      } catch {
        track?.('work_brief_built', { ok: false, ms: Date.now() - started });
      }
      return brief.status();
    }),
    vscode.commands.registerCommand('workspacegpt.askAboutMyWork', async () => {
      const question = await vscode.window.showInputBox({
        title: 'Ask about my work',
        prompt: `Answered from your last ${WINDOW_DAYS} days of tickets, pages, pull requests and calls`,
        placeHolder: 'What did I change in the checkout flow last month?',
        ignoreFocusOut: true,
      });
      if (!question?.trim()) return;
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: (await brief.status()).state === 'ready' ? 'Answering from your brief…' : 'Building your work brief (first time takes a minute)…' },
        () => ask(question)
      );
      const links = result.sources.filter((s) => s.url).slice(0, 3);
      const picked = await vscode.window.showInformationMessage(result.answer, ...links.map((s) => s.tag));
      const target = links.find((s) => s.tag === picked);
      if (target?.url) await vscode.env.openExternal(vscode.Uri.parse(target.url));
    }),
  ];
}
