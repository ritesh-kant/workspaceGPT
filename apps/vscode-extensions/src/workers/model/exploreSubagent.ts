import { parseExplorerOutput, validateClaims, Claim } from './explorationPhase';

/**
 * The callable `explore` sub-agent — a bounded, read-only investigation whose
 * file contents never enter the caller's context.
 *
 * The problem it solves is context hygiene, and ticket #1534774 is the case
 * study. Every read that run made went into the main `messages` array and was
 * re-sent on every subsequent turn: by the time the model had the root cause
 * it was reasoning over ~65k tokens of tool output, most of it files it had
 * already finished with, and it kept reading rather than committing. The
 * pre-loop exploration phase (explorationPhase.ts) already avoids that for
 * the FIRST survey — deterministic scout, tool-less explorers, only cited
 * claims survive — but the model cannot call it, so every question that
 * occurs to it mid-run is paid for at full context price.
 *
 * This is that same trade made available on demand: the sub-agent reads with
 * its own tools, on its own iteration and character budget, and the caller
 * gets back a short table of cited claims. A survey that would have cost the
 * main loop six reads and 40k characters costs it one tool result of ~2k.
 *
 * Three properties are deliberate:
 *
 * - **Read-only.** No writes, no commands, no diagnostics. A delegated
 *   investigation that could edit would be a second agent racing the first
 *   over the same files, and the caller could not review what it did.
 * - **Claims are validated against files it actually opened.** Reusing
 *   explorationPhase's contract means a claim citing a file the sub-agent
 *   never read is dropped rather than passed up as fact. Delegation must not
 *   become a laundering channel for invented file paths — that failure mode
 *   is already documented on this ticket.
 * - **It can never fail the run.** Every error path degrades to a report
 *   saying so, and the caller reads directly instead.
 */

/** The read-only tool names a sub-agent may call. */
export const EXPLORE_TOOL_NAMES = [
  'search_codebase',
  'read_file',
  'find_files',
  'list_directory',
  'find_symbol',
  'find_references',
  'go_to_definition',
] as const;

export interface ExploreTurnOutcome {
  content: string;
  toolCalls: { id: string; name: string; args: string }[];
  apiCalls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ExploreSubagentDeps {
  /** One tool-calling completion, restricted to the tool defs passed in. */
  runTurn(messages: unknown[], toolNames: readonly string[], withTools: boolean): Promise<ExploreTurnOutcome>;
  /** Executes one read-only tool against the workspace. */
  requestTool(name: string, args: unknown): Promise<unknown>;
  onProgress?(label: string): void;
}

export interface ExploreSubagentConfig {
  /** Turns the sub-agent may take before it must answer. */
  maxIterations: number;
  /** Its own tool-output budget — separate from the caller's, which is the point. */
  maxToolChars: number;
  /** Per-result cap inside the sub-agent. */
  maxResultChars: number;
  /** Cap on the report handed back to the caller. */
  maxReportChars: number;
}

export function defaultExploreConfig(isLocalProvider: boolean): ExploreSubagentConfig {
  return {
    maxIterations: isLocalProvider ? 5 : 8,
    maxToolChars: isLocalProvider ? 40_000 : 120_000,
    maxResultChars: isLocalProvider ? 12_000 : 24_000,
    maxReportChars: 2_000,
  };
}

export interface ExploreSubagentResult {
  /** Cited-claim table for the caller's context. Always non-empty. */
  report: string;
  filesRead: string[];
  toolCalls: number;
  iterations: number;
  claimsKept: number;
  claimsDropped: number;
  budgetExhausted: boolean;
  apiCalls: number;
  promptTokens: number;
  completionTokens: number;
}

const EXPLORE_SYSTEM = `You are a read-only investigator working for another engineer who is mid-task and cannot afford to read these files themselves. You have search and read tools. You CANNOT change anything, and you must not suggest a diff — your job is to find out what is true and report it with citations.

How to work:
- Search first to locate candidates, then read only the parts that decide the question.
- Open a file before you say anything about it. You will be asked to cite line numbers, and a claim about a file you did not open is dropped.
- Stop as soon as the question is answered. You are on a small budget and the engineer is waiting.

When you are done, reply with ONLY a single JSON object, no prose before or after, in exactly this shape:
{"claims":[{"fact":"...","file":"path/from/repo/root.ts","lines":"12-40"}],"entryPoints":[{"symbol":"...","file":"path","line":12}],"unknowns":["..."]}

Rules:
- Every "file" must be a path you actually read, copied exactly.
- "lines" must be a real range inside that file.
- Keep each fact under 200 characters, and state a fact — not a plan, not a recommendation.
- If you could not answer, return empty claims and put what is missing in "unknowns". An honest empty answer is useful; an invented one is not.`;

/** Renders validated claims the way the pre-loop phase renders its table. */
function renderReport(
  claims: Claim[],
  entryPoints: { symbol: string; file: string; line: number }[],
  unknowns: string[],
  filesRead: string[],
  maxChars: number
): string {
  let out = '';
  for (const c of claims) {
    const line = c.file ? `- ${c.fact} (${c.file}${c.lines ? `:${c.lines}` : ''})\n` : `- ${c.fact} [uncited]\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  for (const e of entryPoints) {
    const line = `- entry point: \`${e.symbol}\` (${e.file}:${e.line})\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  for (const u of unknowns) {
    const line = `- unknown: ${u}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  if (!out.trim()) {
    return filesRead.length
      ? `No citable findings. Files opened: ${filesRead.join(', ')}. Investigate directly.`
      : 'No findings — the sub-agent could not open any relevant file. Investigate directly.';
  }
  return out.trim();
}

const EMPTY_USAGE = { apiCalls: 0, promptTokens: 0, completionTokens: 0 };

export async function runExploreSubagent(
  question: string,
  scope: string | undefined,
  deps: ExploreSubagentDeps,
  cfg: ExploreSubagentConfig
): Promise<ExploreSubagentResult> {
  const base: ExploreSubagentResult = {
    report: '',
    filesRead: [],
    toolCalls: 0,
    iterations: 0,
    claimsKept: 0,
    claimsDropped: 0,
    budgetExhausted: false,
    ...EMPTY_USAGE,
  };

  const q = String(question ?? '').trim();
  if (!q) {
    return { ...base, report: 'No question was given to explore. Ask a specific question or investigate directly.' };
  }

  // Line counts of files actually opened — both the validation set for claims
  // and what the caller is told was looked at.
  const filesRead = new Map<string, number>();
  let toolChars = 0;
  let budgetExhausted = false;
  const usage = { apiCalls: 0, promptTokens: 0, completionTokens: 0 };

  const messages: unknown[] = [
    { role: 'system', content: EXPLORE_SYSTEM },
    {
      role: 'user',
      content: scope?.trim()
        ? `Question: ${q}\n\nStart here (the caller's hint about where to look): ${scope.trim()}`
        : `Question: ${q}`,
    },
  ];

  let finalContent = '';
  let iterations = 0;
  let toolCalls = 0;

  try {
    for (let i = 0; i < cfg.maxIterations; i++) {
      iterations++;
      const withTools = !budgetExhausted;
      const outcome = await deps.runTurn(messages, EXPLORE_TOOL_NAMES, withTools);
      usage.apiCalls += outcome.apiCalls;
      usage.promptTokens += outcome.promptTokens;
      usage.completionTokens += outcome.completionTokens;

      if (!withTools || outcome.toolCalls.length === 0) {
        finalContent = outcome.content;
        break;
      }

      messages.push({
        role: 'assistant',
        content: outcome.content || null,
        tool_calls: outcome.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.args },
        })),
      });

      const results = await Promise.all(
        outcome.toolCalls.map(async (tc) => {
          // A sub-agent that asks for a tool outside its allowance is told so
          // rather than silently handed nothing — and the restriction is
          // enforced HERE, not merely by which defs it was offered, because
          // models do call tools they were never given.
          if (!(EXPLORE_TOOL_NAMES as readonly string[]).includes(tc.name)) {
            return {
              error: `${tc.name} is not available to a read-only investigation. Use one of: ${EXPLORE_TOOL_NAMES.join(', ')}.`,
            };
          }
          let args: unknown = {};
          try {
            args = tc.args ? JSON.parse(tc.args) : {};
          } catch {
            args = {};
          }
          try {
            const result = await deps.requestTool(tc.name, args);
            if (tc.name === 'read_file') {
              const path = String((args as { path?: unknown })?.path ?? '').replace(/^\.?\//, '');
              const total = Number((result as { totalLines?: unknown })?.totalLines);
              if (path) filesRead.set(path, Number.isFinite(total) ? total : Number.MAX_SAFE_INTEGER);
            }
            return result;
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
        })
      );

      toolCalls += outcome.toolCalls.length;
      outcome.toolCalls.forEach((tc, idx) => {
        let text = JSON.stringify(results[idx] ?? null);
        if (text.length > cfg.maxResultChars) {
          text = text.slice(0, cfg.maxResultChars) + '\n…[truncated]';
        }
        const remaining = cfg.maxToolChars - toolChars;
        if (text.length > remaining) {
          text = text.slice(0, Math.max(0, remaining)) + '\n…[budget spent — answer now with what you have]';
          budgetExhausted = true;
        }
        toolChars += text.length;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: text });
      });

      deps.onProgress?.(`Exploring: ${toolCalls} lookup(s), ${filesRead.size} file(s) read`);
    }

    // Ran out of turns while still calling tools: one no-tools turn so the
    // work already done comes back as claims instead of being thrown away.
    if (!finalContent) {
      const outcome = await deps.runTurn(
        [...messages, { role: 'user', content: 'Budget reached. Answer now, in the required JSON shape, from what you have already read.' }],
        EXPLORE_TOOL_NAMES,
        false
      );
      usage.apiCalls += outcome.apiCalls;
      usage.promptTokens += outcome.promptTokens;
      usage.completionTokens += outcome.completionTokens;
      finalContent = outcome.content;
    }
  } catch (e) {
    // Never fail the caller's run — see the header note.
    return {
      ...base,
      ...usage,
      filesRead: [...filesRead.keys()],
      toolCalls,
      iterations,
      budgetExhausted,
      report: `Exploration failed (${e instanceof Error ? e.message : String(e)}). Investigate directly.`,
    };
  }

  const parsed = parseExplorerOutput(finalContent);
  // Normalize cited paths the same way read paths were recorded, so a claim
  // written "./src/a.ts" against a file recorded as "src/a.ts" is validated
  // rather than dropped as uncited.
  const normalized = {
    ...parsed,
    claims: parsed.claims.map((c) => ({ ...c, file: String(c.file ?? '').replace(/^\.?\//, '') })),
  };
  const { kept, dropped } = validateClaims(normalized, filesRead);
  const report = renderReport(kept, normalized.entryPoints, normalized.unknowns, [...filesRead.keys()], cfg.maxReportChars);

  return {
    report,
    filesRead: [...filesRead.keys()],
    toolCalls,
    iterations,
    claimsKept: kept.length,
    claimsDropped: dropped,
    budgetExhausted,
    ...usage,
  };
}
