import { parentPort, workerData } from 'worker_threads';
import { randomUUID } from 'crypto';
import { createStructuredPrompt } from '../../utils/promptTemplates';
import { MODEL_PROVIDERS } from '../../../constants';
import OpenAI from 'openai';
import { EmbeddingSearchResult } from 'src/types/types';
import { withKeyFailover } from '../../utils/apiKeyFailover';

interface WorkerData {
  prompt: string;
  searchResults: EmbeddingSearchResult[];
  modelId?: string;
  chatHistory?: string;
  provider?: string;
  apiKey?: string;
  /** All configured keys, tried in order with failover on rate-limit (429). */
  apiKeys?: string[];
  currentUserName?: string;
  currentSprint?: { name: string; iterationPath: string; startDate: string; endDate: string } | null;
  /** When enabled, the model gets live codebase tools instead of embedding search results. */
  codebaseTools?: { enabled: boolean };
  /** Pre-built workspace file tree + README head, injected into codebase prompts. */
  repoOrientation?: string;
  /** Merged project rules files (.workspacegpt/rules.md, CLAUDE.md, …). */
  workspaceRules?: string;
}

const {
  prompt,
  searchResults,
  modelId,
  chatHistory,
  provider,
  apiKey,
  apiKeys,
  currentUserName,
  currentSprint,
  codebaseTools,
  repoOrientation,
  workspaceRules,
} = workerData as WorkerData;

// Prefer the full key list; fall back to the single legacy key.
const failoverKeys = apiKeys && apiKeys.length ? apiKeys : apiKey ? [apiKey] : [];

// ── Codebase tool definitions (OpenAI function-calling schema) ────────────

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'search_codebase',
      description:
        'Search the open workspace for a text or regex pattern across files. Returns matching lines (with surrounding context) plus file path and line number. Set outputMode to "files_with_matches" to get only the list of matching files — much cheaper when surveying which files are relevant before reading them.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regex pattern to search for.' },
          glob: { type: 'string', description: 'Optional glob to restrict which files are searched, e.g. "**/*.ts".' },
          caseSensitive: { type: 'boolean', description: 'Whether the search is case-sensitive. Defaults to false.' },
          outputMode: { type: 'string', enum: ['content', 'files_with_matches'], description: '"content" (default) returns matching lines; "files_with_matches" returns only file paths.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_symbol',
      description:
        'Look up a named symbol (function, class, method, variable, interface...) across the workspace using the editor\'s language index. Returns exact definitions with file and line — far more precise than text search for "where is X defined". Prefer this over search_codebase when you know the symbol name.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symbol name or prefix, e.g. "LeadsView" or "sendMessage".' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_references',
      description:
        'Find every place a symbol is used, via the editor\'s language services. Point it at one known occurrence (file + line + symbol text) and it returns all reference sites. Use after locating a symbol to understand how/where it is consumed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path containing the symbol.' },
          line: { type: 'number', description: '1-based line number where the symbol appears.' },
          symbol: { type: 'string', description: 'The symbol text on that line, e.g. "sendMessage".' },
        },
        required: ['path', 'line', 'symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_to_definition',
      description:
        'Jump from a usage of a symbol to its definition, via the editor\'s language services. Point it at an occurrence (file + line + symbol text) and it returns where that symbol is defined.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path containing the usage.' },
          line: { type: 'number', description: '1-based line number of the usage.' },
          symbol: { type: 'string', description: 'The symbol text on that line.' },
        },
        required: ['path', 'line', 'symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file in the workspace, optionally restricted to a line range.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          startLine: { type: 'number', description: '1-based line to start reading from.' },
          endLine: { type: 'number', description: '1-based line to stop reading at (inclusive).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and subdirectories at a workspace-relative path. Omit path to list the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative directory path. Omit for the workspace root.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_docs',
      description:
        "Semantic search over the organization's Confluence knowledge base (design docs, architecture pages, runbooks). Use when the task references org concepts, features, or decisions the code alone can't explain — read the docs BEFORE writing code that implements them.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language search query.' },
          topK: { type: 'number', description: 'Number of results (default 5, max 10).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_tickets',
      description:
        'Semantic search over Azure DevOps work items (tickets, user stories, bugs). Use when the user references a ticket ID or asks to implement/fix something tracked there — read the ticket first to get acceptance criteria and context.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Ticket ID (e.g. "D2C-1234") or natural-language query.' },
          topK: { type: 'number', description: 'Number of results (default 5, max 10).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace (build, test, lint, package scripts). Returns exit code and combined output. The user approves each command before it runs (previously session-approved commands run immediately); destructive commands are blocked outright. Use this to VERIFY your edits — run the relevant test/build after changing code.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run, e.g. "npm test -- --run" or "npx tsc --noEmit".' },
          cwd: { type: 'string', description: 'Workspace-relative working directory. Defaults to the workspace root.' },
          timeoutSec: { type: 'number', description: 'Kill the command after this many seconds (default 60, max 300).' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description:
        "Read the editor's live problems (compile/type/lint errors and warnings) — for one file or the whole workspace. ALWAYS call this after your edits are applied to verify you didn't break the build; errors first, then warnings.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path to check. Omit for all problems in the workspace.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Current git branch and working-tree status (changed/untracked files). Read-only.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Unified diff of uncommitted changes — optionally limited to one path, or the staged changes. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Restrict the diff to this file or directory.' },
          staged: { type: 'boolean', description: 'Show staged (index) changes instead of unstaged. Defaults to false.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Recent commit history (hash, date, author, subject) — optionally for one file. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Restrict history to this file or directory.' },
          maxCount: { type: 'number', description: 'Number of commits to show (default 10, max 20).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_blame',
      description: 'Who last changed each line in a range of a file, with commit and date. Useful for "why is this code like this". Read-only.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          startLine: { type: 'number', description: '1-based first line of the range.' },
          endLine: { type: 'number', description: '1-based last line of the range (max 100 lines).' },
        },
        required: ['path', 'startLine', 'endLine'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace text in a workspace file. oldString must be copied EXACTLY from the current file (use read_file first) including whitespace/indentation, and must appear exactly once — include surrounding lines to disambiguate, or set replaceAll to change every occurrence. The user reviews and approves each edit before it is applied; a rejection comes back as an error with their feedback.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          oldString: { type: 'string', description: 'Exact existing text to replace, copied verbatim from the file.' },
          newString: { type: 'string', description: 'The replacement text.' },
          replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match. Defaults to false.' },
        },
        required: ['path', 'oldString', 'newString'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description:
        'Create a new file with the given content. Fails if the file already exists (use edit_file for existing files). The user reviews and approves the creation before it happens.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path for the new file.' },
          content: { type: 'string', description: 'Full content of the new file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description:
        'Delete a file from the workspace. The user reviews and approves the deletion before it happens.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path of the file to delete.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description:
        'Find files by NAME/path pattern (glob), not by content. Use this when a content search comes up empty or a topic is likely implemented in a file whose name matches the feature (e.g. "**/*Lead*" or "**/*Filter*") — a doc can describe a feature in prose that never appears verbatim in the implementing file.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match file names/paths, e.g. "**/*Lead*" or "**/*.filter.ts".' },
        },
        required: ['pattern'],
      },
    },
  },
];

const MAX_TOOL_ITERATIONS = 10;

const KNOWN_TOOL_NAMES = new Set(
  TOOL_DEFS.map((d: any) => d.function?.name).filter(Boolean)
);

/**
 * Salvages tool calls that a model emitted as plain text instead of the
 * structured tool_calls field. Smaller local models (qwen2.5-coder via
 * Ollama especially) frequently "narrate" a call as a JSON blob — bare,
 * inside a ```json fence, or wrapped in Qwen's <tool_call> tags — in which
 * case the loop would otherwise treat the turn as a final answer and stop
 * mid-exploration.
 */
function extractTextToolCalls(content: string): BufferedToolCall[] {
  if (!content) return [];

  const candidates: string[] = [];
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const fenceRe = /```(?:json|tool_call|tool_code)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(content))) candidates.push(m[1]);
  while ((m = fenceRe.exec(content))) candidates.push(m[1]);
  const trimmed = content.trim();
  if (candidates.length === 0 && trimmed.startsWith('{')) candidates.push(trimmed);

  const calls: BufferedToolCall[] = [];
  for (const candidate of candidates) {
    const text = candidate.trim();
    if (!text.startsWith('{')) continue;
    try {
      const obj = JSON.parse(text);
      const name = obj?.name ?? obj?.tool ?? obj?.function?.name;
      if (typeof name !== 'string' || !KNOWN_TOOL_NAMES.has(name)) continue;
      const rawArgs = obj?.arguments ?? obj?.parameters ?? obj?.function?.arguments ?? {};
      calls.push({
        id: `textcall_${Date.now()}_${calls.length}`,
        name,
        args: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs),
      });
    } catch {
      // Not valid JSON — leave it as prose.
    }
  }
  return calls;
}

async function generateResponse(): Promise<void> {
  try {
    // Get provider configuration
    const providerConfig = MODEL_PROVIDERS.find(p => p.MODEL_PROVIDER === provider);
    if (!providerConfig || !modelId || !failoverKeys.length) {
      throw new Error(`Provider ${provider} or modelId not found`);
    }

    const structuredPrompt = createStructuredPrompt(
      searchResults,
      prompt,
      chatHistory,
      currentUserName,
      currentSprint,
      { codebaseToolsEnabled: !!codebaseTools?.enabled, repoOrientation, workspaceRules }
    );

    if (codebaseTools?.enabled) {
      await runAgentLoop(structuredPrompt, modelId, providerConfig.BASE_URL, failoverKeys);
    } else {
      await generateWithOpenAIStream(structuredPrompt, modelId, providerConfig.BASE_URL, failoverKeys);
    }
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

interface BufferedToolCall {
  id: string;
  name: string;
  args: string;
}

interface StreamOutcome {
  content: string;
}

/**
 * Consumes a streamed chat completion, forwarding content chunks to the UI
 * with `<think>...</think>` stripping — unchanged from the original one-shot
 * path. Used only for plain (non-codebase) turns; the tool-calling agent loop
 * uses non-streaming turns instead (see runToolTurn) since streaming +
 * tool_calls is unreliable across OpenAI-compat providers.
 */
async function consumeStream(stream: AsyncIterable<any>): Promise<StreamOutcome> {
  let fullContent = '';
  let thinkingDone = false;
  let isCheckingThink = true;

  try {
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;

      const contentDelta = delta?.content;
      if (!contentDelta) continue;

      fullContent += contentDelta;

      // Check for <think> tag at the very start
      if (isCheckingThink) {
        if (fullContent.length >= 7) {
          isCheckingThink = false;
          if (!fullContent.startsWith('<think>')) {
            thinkingDone = true;
            // Not a thinking model, send everything we buffered so far
            parentPort?.postMessage({ type: 'chunk', content: fullContent });
          }
        }
        continue;
      }

      // Strip <think>...</think> blocks - only send content after thinking is done
      if (!thinkingDone) {
        const thinkEnd = fullContent.indexOf('</think>');
        if (thinkEnd !== -1) {
          thinkingDone = true;
          const afterThink = fullContent.substring(thinkEnd + 8).trim();
          if (afterThink) {
            parentPort?.postMessage({ type: 'chunk', content: afterThink });
          }
        }
        continue;
      }

      // Send chunk to UI
      parentPort?.postMessage({ type: 'chunk', content: contentDelta });
    }
  } catch (streamError) {
    // Some OpenAI-compatible providers/proxies close the SSE stream without a
    // proper terminator, which the SDK surfaces as "Premature close" even after
    // the full message has already arrived. If we've buffered any content,
    // treat it as a complete response and fall through rather than failing.
    const isPrematureClose =
      streamError instanceof Error && /premature close/i.test(streamError.message);
    if (!isPrematureClose || fullContent.length === 0) {
      throw streamError;
    }
    console.warn(
      '[workspaceGPT] LLM stream closed early after content was received — ' +
        'salvaging buffered response instead of erroring.',
    );
  }

  // Handle case where stream ended before 7 chars
  if (isCheckingThink) {
    parentPort?.postMessage({ type: 'chunk', content: fullContent });
  }

  return {
    content: fullContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim(),
  };
}

async function generateWithOpenAIStream(prompt: string, model: string, baseURL: string, apiKeys: string[]): Promise<void> {
  // Create the stream with key failover. A 429 surfaces at creation (before any
  // chunk), so rotating to the next key here is safe — no partial output yet.
  const stream = await withKeyFailover(apiKeys, (apiKey) => {
    const openai = new OpenAI({ apiKey, baseURL });
    return openai.chat.completions.create({
      model: model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 4096,
      stream: true,
    });
  });

  const outcome = await consumeStream(stream);
  parentPort?.postMessage({ type: 'done', content: outcome.content });
}

/**
 * Delegates a single tool call back to the main extension-host thread (which
 * has access to the `vscode` workspace APIs this worker cannot reach) and
 * awaits the matching response. Scoped per-call: the listener is removed as
 * soon as its response arrives, since several tool calls happen sequentially
 * within the same worker lifetime.
 */
function requestTool(name: string, args: unknown): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const handler = (msg: any) => {
      if (msg?.type === 'tool_response' && msg.id === id) {
        parentPort?.off('message', handler);
        msg.error ? reject(new Error(msg.error)) : resolve(msg.result);
      }
    };
    parentPort?.on('message', handler);
    parentPort?.postMessage({ type: 'tool_request', id, name, arguments: args });
  });
}

/** A single (non-streamed) tool-calling turn's outcome. */
interface ToolTurnOutcome {
  content: string;
  toolCalls: BufferedToolCall[];
  finishReason: string | null;
}

/**
 * Runs one non-streaming completion, with or without tools attached. We
 * deliberately do NOT stream while tools are involved: several OpenAI-compat
 * providers (Gemini's in particular — see
 * https://discuss.ai.google.dev/t/gemini-openai-compatibility-issue-with-tool-call-streaming/59886)
 * drop or duplicate the tool_call `id` across streamed deltas, which then
 * fails the "assistant tool_calls must be followed by matching tool
 * messages" validation on the *next* request and surfaces as an opaque
 * empty-body 400. A non-streaming response returns each tool_call fully
 * formed (real id included), sidestepping that entire class of bug.
 */
async function runToolTurn(
  messages: any[],
  model: string,
  baseURL: string,
  apiKeys: string[],
  withTools: boolean
): Promise<ToolTurnOutcome> {
  const response = await withKeyFailover(apiKeys, (apiKey) => {
    const openai = new OpenAI({ apiKey, baseURL });
    return openai.chat.completions.create({
      model,
      messages,
      ...(withTools ? { tools: TOOL_DEFS as any, tool_choice: 'auto' as const } : {}),
      temperature: 0.3,
      // Reasoning models (Gemini 2.5+) spend "thinking" tokens out of this same
      // budget — 4096 can be exhausted before any visible output is produced.
      max_tokens: 8192,
      stream: false,
    });
  });

  const message = response.choices[0]?.message;
  const toolCalls: BufferedToolCall[] = (message?.tool_calls ?? []).map((tc: any) => ({
    id: tc.id,
    name: tc.function?.name ?? '',
    args: tc.function?.arguments ?? '',
  }));

  return {
    content: (message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(),
    toolCalls,
    finishReason: response.choices[0]?.finish_reason ?? null,
  };
}

/**
 * Multi-turn tool-calling loop for codebase questions: the model may call
 * search_codebase/read_file/list_directory any number of times (capped),
 * with each tool result appended to the conversation before the next
 * completion — mirrors how Claude Code itself explores a repo, instead of
 * relying on a pre-built embedding index. Non-streaming throughout (see
 * runToolTurn); the final answer is sent as a single buffered chunk, which
 * the webview's existing typewriter pump animates the same as a live stream.
 */
// Bounds on tool output fed back into the conversation. `messages` grows every
// iteration, so without a cumulative cap a long exploration can blow the
// context window (especially on local models) before the model ever answers.
const MAX_TOOL_RESULT_CHARS = 12_000;
const MAX_TOTAL_TOOL_CHARS = 48_000;

async function runAgentLoop(initialPrompt: string, model: string, baseURL: string, apiKeys: string[]): Promise<void> {
  const messages: any[] = [{ role: 'user', content: initialPrompt }];
  let toolCharsUsed = 0;
  let toolCallsExecuted = 0;
  let planNudgesUsed = 0;
  // Smaller local models often ANNOUNCE their tool plan in prose ("I will use
  // find_files to...") without ever emitting a call. A couple of corrective
  // turns rescues those runs; past that, return whatever the model has.
  const MAX_PLAN_NUDGES = 2;

  const serializeToolResult = (result: unknown): string => {
    let s = JSON.stringify(result);
    if (s.length > MAX_TOOL_RESULT_CHARS) {
      s = s.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[result truncated — narrow the query or read a specific line range]';
    }
    const remaining = MAX_TOTAL_TOOL_CHARS - toolCharsUsed;
    if (s.length > remaining) {
      s = s.slice(0, Math.max(0, remaining)) + '\n…[tool output budget exhausted — answer now with what you have]';
    }
    toolCharsUsed += s.length;
    return s;
  };

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const outcome = await runToolTurn(messages, model, baseURL, apiKeys, true);

    // Exit on absence of tool calls only — several OpenAI-compat providers
    // (Gemini, Ollama) report finish_reason 'stop' even when tool_calls are
    // populated, which would otherwise abort the loop mid-exploration. Before
    // giving up, salvage calls the model wrote as plain text/JSON in content.
    let toolCalls = outcome.toolCalls;
    let salvaged = false;
    if (toolCalls.length === 0 && outcome.content) {
      toolCalls = extractTextToolCalls(outcome.content);
      salvaged = toolCalls.length > 0;
    }

    if (toolCalls.length === 0) {
      // A "final answer" that names tools is almost always a narrated plan,
      // not an answer ("I will use find_files to locate..."). Same for an
      // empty response before any tool has run. Push back and let it retry.
      const mentionsTool = [...KNOWN_TOOL_NAMES].some((n) => outcome.content.includes(n));
      const emptyBeforeAnyTool = !outcome.content.trim() && toolCallsExecuted === 0;
      if ((mentionsTool || emptyBeforeAnyTool) && planNudgesUsed < MAX_PLAN_NUDGES) {
        planNudgesUsed++;
        messages.push({ role: 'assistant', content: outcome.content || '(empty response)' });
        messages.push({
          role: 'user',
          content:
            'Do not describe your plan — EXECUTE it. Invoke the tools now via the function-calling mechanism (not as text or JSON in your reply). Do not write any prose until you have tool results to report.',
        });
        continue;
      }
      if (outcome.content) parentPort?.postMessage({ type: 'chunk', content: outcome.content });
      parentPort?.postMessage({ type: 'done', content: outcome.content });
      return;
    }

    messages.push({
      role: 'assistant',
      // For salvaged calls, drop the narrated JSON from history — the
      // structured tool_calls below replace it, and echoing it back teaches
      // the model to keep answering in that broken format.
      content: salvaged ? null : outcome.content || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.args },
      })),
    });

    // Models often request several independent lookups in one turn — run them
    // concurrently (each is a main-thread round trip), then append results in
    // the original tool_calls order as the OpenAI protocol requires.
    const results = await Promise.all(
      toolCalls.map(async (tc) => {
        let parsedArgs: unknown = {};
        try {
          parsedArgs = tc.args ? JSON.parse(tc.args) : {};
        } catch {
          parsedArgs = {};
        }
        parentPort?.postMessage({ type: 'tool_status', name: tc.name, arguments: parsedArgs });
        try {
          return await requestTool(tc.name, parsedArgs);
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      })
    );

    toolCalls.forEach((tc, idx) => {
      messages.push({ role: 'tool', tool_call_id: tc.id, content: serializeToolResult(results[idx]) });
    });
    toolCallsExecuted += toolCalls.length;
  }

  // Hit MAX_TOOL_ITERATIONS: force a final answer without tools so the user
  // always gets a response instead of hanging or erroring.
  const finalOutcome = await runToolTurn(messages, model, baseURL, apiKeys, false);
  if (finalOutcome.content) parentPort?.postMessage({ type: 'chunk', content: finalOutcome.content });
  parentPort?.postMessage({ type: 'done', content: finalOutcome.content });
}

// Start processing
generateResponse();
