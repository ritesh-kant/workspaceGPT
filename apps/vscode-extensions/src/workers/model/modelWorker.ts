import { parentPort, workerData } from 'worker_threads';
import { randomUUID } from 'crypto';
import { createStructuredPrompt } from '../../utils/promptTemplates';
import { MODEL_PROVIDERS } from '../../../constants';
import OpenAI from 'openai';
import { EmbeddingSearchResult } from 'src/types/types';
import { withKeyFailover } from '../../utils/apiKeyFailover';
import { extractBalancedJsonObjects } from './jsonExtract';
import { runExplorationPhase, defaultExplorationConfig } from './explorationPhase';
import { normalizeModelId } from '../../utils/normalizeModelId';

interface WorkerData {
  prompt: string;
  searchResults: EmbeddingSearchResult[];
  modelId?: string;
  chatHistory?: string;
  provider?: string;
  apiKey?: string;
  /** All configured keys, tried in order with failover on rate-limit (429). */
  apiKeys?: string[];
  /** User-supplied base URL for the 'Custom' provider; overrides MODEL_PROVIDERS. */
  baseUrl?: string;
  currentUserName?: string;
  currentSprint?: { name: string; iterationPath: string; startDate: string; endDate: string } | null;
  /** When enabled, the model gets live codebase tools instead of embedding search results. */
  codebaseTools?: { enabled: boolean };
  /** Text files the user attached — inlined into the structured prompt. */
  textAttachments?: { name: string; content: string }[];
  /** Image files the user attached — sent as multimodal image_url parts (vision models). */
  imageAttachments?: { name: string; dataUrl: string }[];
  /** Contents of the files/folders the user @-mentioned, already read host-side. */
  mentionedFiles?: { name: string; content: string }[];
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
  baseUrl,
  currentUserName,
  currentSprint,
  codebaseTools,
  textAttachments,
  imageAttachments,
  mentionedFiles,
  repoOrientation,
  workspaceRules,
} = workerData as WorkerData;

// Prefer the full key list; fall back to the single legacy key.
const failoverKeys = apiKeys && apiKeys.length ? apiKeys : apiKey ? [apiKey] : [];

/**
 * The user turn's `content` value: a plain string normally, or OpenAI
 * multimodal content parts when the user attached images. Only vision-capable
 * models accept image parts — others reject the request, and that provider
 * error surfaces in the chat as usual.
 */
function imagesToContentParts(
  images: { dataUrl: string }[]
): OpenAI.Chat.Completions.ChatCompletionContentPartImage[] {
  return images.map((img) => ({ type: 'image_url' as const, image_url: { url: img.dataUrl } }));
}

function buildUserContent(text: string): string | OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  if (!imageAttachments?.length) return text;
  return [{ type: 'text' as const, text }, ...imagesToContentParts(imageAttachments)];
}

/** True when the provider rejected the request specifically over image/vision content, not a generic 400. */
function isInvalidImageError(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (status !== 400) return false;
  const msg = String(err?.message ?? '').toLowerCase();
  return /image/.test(msg) && /(invalid|not support|unsupported|vision)/.test(msg);
}

/**
 * Whether a failed request is worth retrying with the images removed.
 *
 * Matching the error TEXT is not enough: Gemini rejects image content it can't
 * use with a completely empty 400 body, so the SDK reports only "400 status
 * code (no body)" — nothing for isInvalidImageError's regex to match, and the
 * strip-and-retry below never fired. A bodyless 400 is evidence of nothing in
 * particular, so if the conversation carries images at all, dropping them is
 * the cheapest thing to rule out (it also shrinks a request that may simply be
 * too large — a ticket's four inline screenshots are megabytes of base64).
 * The caller only retries when images were actually present, and a second
 * failure rethrows the original error.
 */
function shouldRetryWithoutImages(err: any): boolean {
  if (isInvalidImageError(err)) return true;
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  return status === 400 && /status code \(no body\)/i.test(String(err?.message ?? ''));
}

function isImageContentPart(part: any): boolean {
  return !!part && typeof part === 'object' && part.type === 'image_url';
}

/** Drops image_url parts from a chat content value, collapsing back to a plain string when only one text part remains. Returns [content, changed]. */
function stripImageParts(content: unknown): [unknown, boolean] {
  if (!Array.isArray(content)) return [content, false];
  const filtered = content.filter((part) => !isImageContentPart(part));
  if (filtered.length === content.length) return [content, false];
  if (filtered.length === 1 && filtered[0]?.type === 'text') return [filtered[0].text, true];
  return [filtered, true];
}

/** Mutates `messages` in place, stripping image content the provider just rejected — so later turns in the same run don't resend it either. Returns true if anything was removed. */
function stripImageContentFromMessages(messages: any[]): boolean {
  let changed = false;
  for (const m of messages) {
    const [next, didChange] = stripImageParts(m.content);
    if (didChange) {
      m.content = next;
      changed = true;
    }
  }
  return changed;
}

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
        'Semantic search over Azure DevOps work items by DESCRIPTION or topic (e.g. "tickets about checkout retries"). Searches the local synced index, so it may be stale and is unreliable for exact IDs — when you already have a ticket ID, use get_ticket instead.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language description of the work item to find.' },
          topK: { type: 'number', description: 'Number of results (default 5, max 10).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_ticket',
      description:
        'Read ONE Azure DevOps work item by ID, live from Azure DevOps (always current, never truncated). Use this whenever the user names a ticket — it returns the title, state, assignee, sprint, description and acceptance criteria. Read the ticket BEFORE exploring code so you implement what was actually asked for.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description:
              'Work item ID as the user wrote it — any prefix is tolerated ("1234", "TKT-1234", "#1234").',
          },
          includeComments: {
            type: 'boolean',
            description:
              'Also fetch the discussion thread. Costly in tokens — request it only when the description and acceptance criteria are too thin to act on.',
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        "Live web search for anything the codebase and org docs can't answer — an unfamiliar library/API/product, current documentation, or something that changed since training. Use it when a name or concept is unrecognized rather than guessing. Returns a synthesized answer (when available) plus source snippets with URLs — cite the URLs when you use them.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The web search query.' },
          maxResults: { type: 'number', description: 'Number of results (default 5, max 10).' },
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
      // No `parameters` key at all — the canonical shape for a no-argument
      // function, accepted by OpenAI and the OpenAI-compatible routers alike.
      // An object schema with an empty `properties` map is the shakier form:
      // providers that convert declarations to their own function schema
      // (Gemini) have no `properties` to map. Never confirmed to have caused a
      // failure here — kept because the declared-no-args form is the portable
      // one, and one bad declaration would fail every tool-using turn.
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
        'Replace text in a workspace file. oldString must be copied character-for-character from the read_file output — KEEP the original line breaks and indentation, NEVER collapse multiple lines onto one line or retype code from memory — and must appear exactly once. A short line like "return a + b;" often occurs in SEVERAL functions: make oldString the WHOLE enclosing block from its header line down (e.g. the full function), so the match is unique on the first try. Set replaceAll only to change every occurrence. The user reviews and approves each edit before it is applied; a rejection comes back as an error with their feedback.',
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

// Ollama is the only provider running against a local, typically small-context
// model — everything else (Requesty, OpenRouter, NVIDIA, hosted OpenAI/Gemini/
// Groq) fronts models with much larger context windows and can afford to read
// a lot more of the repo before answering. A fixed budget sized for local
// models starved remote agent runs on large monorepos (see P: monorepo tool
// budget exhaustion) — the model burned its full result budget in 2-3 search/
// read calls, then spent the rest of MAX_TOOL_ITERATIONS calling tools that
// came back with nothing but "[budget exhausted]".
const isLocalProvider = (provider ?? '').toLowerCase() === 'ollama';
// 20 for local (was 10): edit-heavy tasks need recovery headroom — a weak
// model spends turns redundantly (5 get_diagnostics + 3 test runs observed in
// one 4-edit rename) yet productively, and agent-evals s2 runs kept ending AT
// the cap with the rename nearly complete and the final forced answer merely
// announcing the remaining edit. The tool-output char budget (below) still
// bounds context growth independently, and the harness/UI wall-clock stays
// well inside its timeout at this depth.
const MAX_TOOL_ITERATIONS = isLocalProvider ? 20 : 25;

const isOpenRouter = (provider ?? '').toLowerCase() === 'openrouter';

// ── Latency-adaptive degradation ──
// Everything above (exploration decomposition, reflection/nudge extras, a
// 25-turn cap) assumes turns that cost a few seconds. On a slow serving path
// (free-tier OpenRouter reasoning models routinely take ~60s PER completion)
// the same architecture multiplies into a 10-minute answer. Once observed
// latency crosses these thresholds the run degrades: fewer iterations, no
// optional-polish reflection turns, and a visible warning in the timeline.
const SLOW_TURN_MS = 20_000;
// A single first turn this slow is enough evidence on its own.
const SLOW_FIRST_TURN_MS = 45_000;
const SLOW_MODEL_ITERATION_CAP = 8;

const KNOWN_TOOL_NAMES = new Set(
  TOOL_DEFS.map((d: any) => d.function?.name).filter(Boolean)
);

/** Tools that change workspace state — never executed concurrently. */
const MUTATING_TOOL_NAMES = new Set(['edit_file', 'create_file', 'delete_file', 'run_command']);

/** File-mutating subset whose success must be verified by diagnostics before the run may end. */
const FILE_WRITE_TOOL_NAMES = new Set(['edit_file', 'create_file', 'delete_file']);

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

  const wrapped: string[] = [];
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const fenceRe = /```(?:json|tool_call|tool_code)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(content))) wrapped.push(m[1]);
  while ((m = fenceRe.exec(content))) wrapped.push(m[1]);
  // Each wrapper may itself hold several objects; with no wrappers at all,
  // scan the whole reply — the KNOWN_TOOL_NAMES filter below keeps prose that
  // merely mentions JSON from producing false positives.
  const candidates = wrapped.length
    ? wrapped.flatMap((w) => extractBalancedJsonObjects(w))
    : extractBalancedJsonObjects(content);

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
    const resolvedBaseUrl = providerConfig?.BASE_URL || baseUrl;
    if (!resolvedBaseUrl || !modelId || !failoverKeys.length) {
      throw new Error(`Provider ${provider} or modelId not found`);
    }
    // Normalized once here: every downstream completion (the streaming path,
    // the agent loop's tool turns, and the exploration phase's explorers) is
    // handed this value.
    const resolvedModelId = normalizeModelId(modelId);

    const structuredPrompt = createStructuredPrompt(
      searchResults,
      prompt,
      chatHistory,
      currentUserName,
      currentSprint,
      {
        codebaseToolsEnabled: !!codebaseTools?.enabled,
        repoOrientation,
        workspaceRules,
        textAttachments,
        imageAttachmentNames: imageAttachments?.map((img) => img.name),
        mentionedFiles,
      }
    );

    if (codebaseTools?.enabled) {
      await runAgentLoop(structuredPrompt, resolvedModelId, resolvedBaseUrl, failoverKeys);
    } else {
      await generateWithOpenAIStream(structuredPrompt, resolvedModelId, resolvedBaseUrl, failoverKeys);
    }
  } catch (error: any) {
    // The UI only ever shows `error.message` (e.g. "400 Backend request
    // failed with status 400"), which is the OpenAI SDK's terse summary —
    // it drops the provider's actual JSON error body, request context, and
    // which key/model/provider combo was in play. Log the full picture to
    // the extension host console (visible in the "Extension Host" output
    // channel) so a failure like this is debuggable without reproducing it
    // against a raw HTTP client.
    console.error('[workspaceGPT] LLM request failed:', {
      provider,
      model: modelId,
      baseUrl: baseUrl,
      status: error?.status ?? error?.statusCode ?? error?.response?.status,
      providerError: error?.error ?? error?.response?.data,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
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
      const choice = chunk.choices?.[0];
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

/** Surfaces a key-rotation event to the main thread so it can show it in the UI instead of leaving it silent in the extension host console. */
function notifyKeyFailover(message: string): void {
  parentPort?.postMessage({ type: 'key_failover', message });
}

async function generateWithOpenAIStream(prompt: string, model: string, baseURL: string, apiKeys: string[]): Promise<void> {
  let userContent = buildUserContent(prompt);
  const call = (apiKey: string) => {
    const openai = new OpenAI({ apiKey, baseURL });
    return openai.chat.completions.create({
      model: model,
      messages: [
        {
          role: 'user',
          content: userContent,
        }
      ],
      temperature: 0.3,
      max_tokens: 4096,
      stream: true,
    });
  };

  // Create the stream with key failover. A 429 surfaces at creation (before any
  // chunk), so rotating to the next key here is safe — no partial output yet.
  let stream;
  try {
    stream = await withKeyFailover(apiKeys, call, notifyKeyFailover);
  } catch (err) {
    const [stripped, changed] = stripImageParts(userContent);
    if (shouldRetryWithoutImages(err) && changed) {
      userContent = stripped as typeof userContent;
      parentPort?.postMessage({
        type: 'image_unsupported',
        message: `${model} couldn't process the attached image(s) — continuing without them.`,
      });
      stream = await withKeyFailover(apiKeys, call, notifyKeyFailover);
    } else {
      throw err;
    }
  }

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
function requestTool(name: string, args: unknown, id: string = randomUUID()): Promise<unknown> {
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

/** Token usage for one (or more, if retried) API call(s) backing a turn. */
interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** true if the provider's response carried no `usage` field at all. */
  missing: boolean;
}

/** A single (non-streamed) tool-calling turn's outcome. */
interface ToolTurnOutcome {
  content: string;
  toolCalls: BufferedToolCall[];
  finishReason: string | null;
  usage: TurnUsage;
  /** Number of underlying API calls this outcome represents (>1 when the length-retry fired). */
  apiCalls: number;
}

function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    missing: a.missing && b.missing,
  };
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
/**
 * Checks the structural invariants every OpenAI-compatible provider enforces on
 * a tool-calling conversation. Providers report violations uselessly — Gemini
 * with an empty-body 404, others with a generic 400 — so when a request fails
 * we run this to name the actual defect instead of guessing at it.
 */
function findEnvelopeViolations(messages: any[]): string[] {
  const violations: string[] = [];
  const pendingIds = new Map<string, string>(); // tool_call_id -> function name, awaiting its result

  messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      // A previous assistant turn's calls must all have been answered by now.
      for (const [id, name] of pendingIds) {
        violations.push(`[${i}] new assistant tool_calls while ${name} (id ${id}) was never answered`);
      }
      pendingIds.clear();
      for (const tc of m.tool_calls) {
        const name = tc.function?.name;
        if (!name || !KNOWN_TOOL_NAMES.has(name)) {
          violations.push(`[${i}] assistant calls undeclared function "${name}" (not in TOOL_DEFS)`);
        }
        if (!tc.id) violations.push(`[${i}] assistant tool_call for "${name}" has no id`);
        else pendingIds.set(tc.id, name ?? '?');
      }
      return;
    }

    if (m.role === 'tool') {
      if (!m.tool_call_id) violations.push(`[${i}] tool message has no tool_call_id`);
      else if (!pendingIds.has(m.tool_call_id)) {
        violations.push(`[${i}] tool result references unknown/already-answered id ${m.tool_call_id}`);
      } else pendingIds.delete(m.tool_call_id);
      return;
    }

    // Any other role appearing while calls are unanswered breaks the required
    // contiguous assistant-tool_calls → tool-results block.
    for (const [id, name] of pendingIds) {
      violations.push(`[${i}] role "${m.role}" interleaved before ${name} (id ${id}) was answered`);
    }
    if (pendingIds.size) pendingIds.clear();
  });

  for (const [id, name] of pendingIds) {
    violations.push(`[end] ${name} (id ${id}) requested but never answered`);
  }
  return violations;
}

/** Compact role/tool_call outline of the conversation, for failure diagnostics. */
function describeEnvelope(messages: any[]): string[] {
  return messages.map((m, i) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return `${i} assistant tool_calls=[${m.tool_calls.map((tc: any) => `${tc.function?.name}#${tc.id}`).join(', ')}]`;
    }
    if (m.role === 'tool') return `${i} tool -> #${m.tool_call_id}`;
    const kind = Array.isArray(m.content) ? `parts(${m.content.map((p: any) => p.type).join('+')})` : 'text';
    return `${i} ${m.role} ${kind}`;
  });
}

async function runToolTurn(
  messages: any[],
  model: string,
  baseURL: string,
  apiKeys: string[],
  withTools: boolean,
  maxTokens: number = 8192,
  allowLengthRetry: boolean = true
): Promise<ToolTurnOutcome> {
  const call = (apiKey: string) => {
    const openai = new OpenAI({ apiKey, baseURL });
    return openai.chat.completions.create({
      model,
      messages,
      ...(withTools ? { tools: TOOL_DEFS as any, tool_choice: 'auto' as const } : {}),
      // Cap thinking on reasoning models: tool turns need a quick decision,
      // not a minute of deliberation, and unconstrained reasoning is the main
      // latency + token cost on models like Nemotron. OpenRouter normalizes
      // this param across providers and drops it for models without reasoning;
      // other OpenAI-compat providers may reject unknown params, so it is
      // gated to OpenRouter only.
      ...(isOpenRouter ? ({ reasoning: { effort: 'low' } } as any) : {}),
      temperature: 0.3,
      // Reasoning models (Gemini 2.5+, Nemotron) spend "thinking" tokens out of
      // this same budget — 4096 can be exhausted before any visible output is
      // produced.
      max_tokens: maxTokens,
      stream: false,
    });
  };

  let response;
  try {
    response = await withKeyFailover(apiKeys, call, notifyKeyFailover);
  } catch (err) {
    // A ticket's images (or a pasted screenshot) ride along as image_url
    // content parts (see imagesToContentParts); a model without vision
    // support rejects them with a 400 instead of ignoring them. Strip the
    // images from the conversation in place — so later turns don't resend
    // them either — and retry once as text-only rather than failing the
    // whole run over an attachment the model can't use.
    if (shouldRetryWithoutImages(err) && stripImageContentFromMessages(messages)) {
      console.error('[workspaceGPT] request rejected with images attached — retrying without them.');
      parentPort?.postMessage({
        type: 'image_unsupported',
        message: `${model} couldn't process the attached image(s) — continuing without them.`,
      });
      response = await withKeyFailover(apiKeys, call, notifyKeyFailover);
    } else {
      // A malformed conversation is the most common cause of an opaque 4xx
      // here; report the specific structural defect rather than leaving only
      // the provider's unhelpful status line.
      const violations = findEnvelopeViolations(messages);
      if (violations.length) {
        console.error('[workspaceGPT] malformed tool-call conversation:', violations);
      }
      console.error('[workspaceGPT] message envelope at failure:', describeEnvelope(messages));
      throw err;
    }
  }

  // Some providers (OpenRouter free-tier models especially, under load or
  // rate limiting) return HTTP 200 with an error payload instead of a real
  // completion — no `choices` array at all. The OpenAI SDK only throws on
  // non-2xx responses, so this slips through as a malformed success and
  // must be checked explicitly instead of indexing into `choices` directly.
  if (!response.choices?.length) {
    const apiError = (response as any)?.error;
    throw new Error(apiError?.message || 'Model provider returned no choices (malformed or error response)');
  }

  const message = response.choices[0]?.message;
  const toolCalls: BufferedToolCall[] = (message?.tool_calls ?? []).map((tc: any) => ({
    id: tc.id,
    name: tc.function?.name ?? '',
    args: tc.function?.arguments ?? '',
  }));
  const content = (message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const finishReason = response.choices[0]?.finish_reason ?? null;
  // Some OpenAI-compatible providers (Nemotron via Requesty, Gemini 2.5+)
  // return reasoning in a separate field instead of/alongside `content`. A
  // response that is all reasoning and no visible content, cut off by the
  // token cap, looks identical to a genuinely empty answer unless we check
  // for it — retry once with a much larger budget so the model gets a turn
  // to actually answer instead of just think.
  const reasoningContent: string = (message as any)?.reasoning_content ?? (message as any)?.reasoning ?? '';
  const rawUsage = (response as any)?.usage;
  const usage: TurnUsage = {
    promptTokens: rawUsage?.prompt_tokens ?? 0,
    completionTokens: rawUsage?.completion_tokens ?? 0,
    totalTokens: rawUsage?.total_tokens ?? 0,
    missing: !rawUsage,
  };
  if (!content && toolCalls.length === 0 && allowLengthRetry && (finishReason === 'length' || reasoningContent)) {
    const retried = await runToolTurn(messages, model, baseURL, apiKeys, withTools, Math.max(maxTokens * 2, 16384), false);
    return { ...retried, apiCalls: retried.apiCalls + 1, usage: addUsage(usage, retried.usage) };
  }

  return {
    content,
    toolCalls,
    finishReason: response.choices[0]?.finish_reason ?? null,
    usage,
    apiCalls: 1,
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
const MAX_TOOL_RESULT_CHARS = isLocalProvider ? 12_000 : 20_000;
const MAX_TOTAL_TOOL_CHARS = isLocalProvider ? 48_000 : 200_000;

async function runAgentLoop(initialPrompt: string, model: string, baseURL: string, apiKeys: string[]): Promise<void> {
  const messages: any[] = [{ role: 'user', content: buildUserContent(initialPrompt) }];
  // ── Efficiency metrics (consumed by packages/agent-evals, not the chat UI) ──
  const runStarted = Date.now();
  interface PerTurnMetric {
    turn: number;
    ms: number;
    apiCalls: number;
    promptTokens: number;
    completionTokens: number;
    toolCallsRequested: number;
    salvaged: boolean;
  }
  const perTurn: PerTurnMetric[] = [];
  let apiCallsTotal = 0;
  let promptTokensTotal = 0;
  let completionTokensTotal = 0;
  let usageMissingTurns = 0;
  const noteTurn = (ms: number, outcome: ToolTurnOutcome, toolCallsRequested: number, salvaged: boolean) => {
    perTurn.push({
      turn: perTurn.length,
      ms,
      apiCalls: outcome.apiCalls,
      promptTokens: outcome.usage.promptTokens,
      completionTokens: outcome.usage.completionTokens,
      toolCallsRequested,
      salvaged,
    });
    apiCallsTotal += outcome.apiCalls;
    promptTokensTotal += outcome.usage.promptTokens;
    completionTokensTotal += outcome.usage.completionTokens;
    turnMsTotal += ms;
    if (outcome.usage.missing) usageMissingTurns++;
  };
  let toolCharsUsed = 0;
  let toolCallsExecuted = 0;
  let planNudgesUsed = 0;
  // ── Latency-adaptive degradation state (see SLOW_TURN_MS above) ──
  let turnMsTotal = 0;
  let slowModelMode = false;
  let iterationCap = MAX_TOOL_ITERATIONS;
  const enterSlowMode = (observedMs: number, atIteration: number) => {
    if (slowModelMode) return;
    slowModelMode = true;
    // Leave a little room past the current iteration so a run detected late
    // can still land an answer, but never extend beyond the original cap.
    iterationCap = Math.min(MAX_TOOL_ITERATIONS, Math.max(atIteration + 2, SLOW_MODEL_ITERATION_CAP));
    parentPort?.postMessage({
      type: 'slow_model',
      avgSec: Math.round(observedMs / 1000),
      cap: iterationCap,
    });
  };
  const maybeEnterSlowMode = (atIteration: number) => {
    if (slowModelMode || perTurn.length === 0) return;
    const avgMs = turnMsTotal / perTurn.length;
    if (perTurn[0].ms > SLOW_FIRST_TURN_MS || (perTurn.length >= 2 && avgMs > SLOW_TURN_MS)) {
      enterSlowMode(avgMs, atIteration);
    }
  };
  // Verification discipline (P2.4): a run that APPLIED file writes may not end
  // without a diagnostics check, and may not end silently. Models — local ones
  // especially — skip both when left to their own devices.
  let writesApplied = 0;
  let writesSinceDiagnostics = 0;
  let autoDiagnosticsRan = false;
  let summaryNudgeUsed = false;
  // Repeating an identical call that already failed burns turns for nothing —
  // qwen retried the SAME failing edit 6× in one observed run. Short-circuit
  // repeats with escalating guidance instead of executing them.
  const failedCalls = new Map<string, number>();
  // Files whose CURRENT content the model has seen (read_file succeeded, or it
  // authored the content via create_file). An edit_file against any other file
  // is guaranteed to be oldString-from-memory — observed live with qwen editing
  // app.js/test.js with fully invented content ("// Output: 5") having never
  // read them. Instead of executing the doomed edit, hand back the real file
  // so the very next attempt can copy verbatim.
  const readPaths = new Set<string>();
  const normPath = (p: unknown): string => String(p ?? '').replace(/^\.?\//, '');
  const EDIT_UNREAD_CONTENT_CAP = 4_000;
  // Last write outcome per file: a run must not end claiming success while
  // some file's most recent write attempt failed (models happily do this).
  const lastWriteOutcome = new Map<string, boolean>();
  let failedWritesNudgeUsed = false;
  let anyWriteAttempted = false;
  // Two attempts, not one: observed live, qwen answered the first phantom
  // nudge with "I apologize for the confusion. The function has been
  // successfully renamed..." — an apology plus the SAME false claim — and the
  // once-only gate let that second claim through.
  let phantomChangesNudgesUsed = 0;
  // An answer grounded in ZERO successful tool results is a guess, whatever it
  // claims — observed live: find_symbol errored ("language services
  // unavailable"), find_references was called with literal placeholder args
  // ("<path-to-add-function>") and errored too, and the model answered "the
  // function is not found in the codebase". Challenge that once.
  let okToolResults = 0;
  let allErrorsNudgeUsed = false;
  // Smaller local models often ANNOUNCE their tool plan in prose ("I will use
  // find_files to...") without ever emitting a call. A couple of corrective
  // turns rescues those runs; past that, return whatever the model has.
  const MAX_PLAN_NUDGES = 2;
  // Models also stop mid-task with a partial answer that ANNOUNCES the
  // remaining work instead of doing it ("the cloudwatch.tf file needs to be
  // examined to see the schedule") — observed live with gemini-2.5-flash,
  // forcing the user to type "continue". The plan-nudge above can't catch it:
  // these answers name files, not tools. Same bounded treatment.
  // Even when nothing is self-declared missing, fast models satisfice: asked
  // "how is X triggered", gemini-2.5-flash found ONE trigger (the CloudWatch
  // rule) and confidently answered, missing the event subscription and manual
  // invocation defined in the same app. A regex can't detect incompleteness
  // the model doesn't admit to — so every tool-using run gets exactly one
  // reflection round before its answer is accepted: re-check coverage, verify
  // gaps with tools, or return the same answer.
  let completenessReflectionUsed = false;
  let incompleteAnswerNudgesUsed = 0;
  const INCOMPLETE_ANSWER_RE =
    /\b(needs? to be (examined|checked|read|inspected|verified|investigated|explored)|need(s)? to (examine|check|read|inspect|verify|investigate|explore)|would need to (look|check|read|examine|verify)|further (investigation|examination|analysis|exploration) (is|would be|may be|might be) (needed|required)|next step (is|would be) to|(I|let me|let'?s|let us) (will |shall |now )?(now )?(check|examine|read|look at|inspect|verify|investigate|search|find|locate|update|fix|rename|edit|modify|apply|retry|re-?run)\b|remains? to be (seen|checked|examined|verified)|have (not|n't) (yet )?(checked|examined|read|verified))/i;

  // Once the cumulative tool-output budget is gone, every further tool call
  // gets back nothing but the "[budget exhausted]" marker — the model can't
  // see any new data, yet without this flag it kept spending whole
  // iterations calling tools anyway (observed: 7 of 10 rounds wasted this way
  // on a large monorepo query). Once set, the round-robin loop below stops
  // accepting further tool calls and forces the final answer immediately.
  let budgetExhausted = false;
  // Populated by the exploration phase below, if it ran — surfaced in metrics
  // so its token cost is visible against the baseline it's meant to beat.
  let explorationStats: import('./explorationPhase').ExplorationStats | null = null;

  // `get_ticket` results can carry base64 image data (see below) — that must
  // never land in the text tool message, both because `role: 'tool'` content
  // is a plain string (no image parts allowed there) and because dumping raw
  // base64 into it would burn context budget on useless text tokens.
  const stripImagesForToolText = (name: string, result: unknown): unknown => {
    if (name !== 'get_ticket' || !result || typeof result !== 'object') return result;
    const r = result as { images?: { name: string }[] };
    if (!Array.isArray(r.images) || !r.images.length) return result;
    const { images, ...rest } = r as Record<string, unknown>;
    return { ...rest, imageCount: (images as { name: string }[]).length, imageNames: (images as { name: string }[]).map((im) => im.name) };
  };

  const serializeToolResult = (result: unknown): string => {
    let s = JSON.stringify(result);
    if (s.length > MAX_TOOL_RESULT_CHARS) {
      s = s.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[result truncated — narrow the query or read a specific line range]';
    }
    const remaining = MAX_TOTAL_TOOL_CHARS - toolCharsUsed;
    if (s.length > remaining) {
      s = s.slice(0, Math.max(0, remaining)) + '\n…[tool output budget exhausted — answer now with what you have]';
      budgetExhausted = true;
    }
    toolCharsUsed += s.length;
    return s;
  };

  // ── Microcompaction (token-pressure relief) ──
  // Every iteration resends the whole conversation, so tool results are
  // re-billed on every subsequent round. `messages` stays strictly append-only
  // while there's headroom — providers with implicit prefix caching (Gemini,
  // OpenAI-compat routers) then serve the shared prefix from cache. Only when
  // usage crosses the pressure threshold do we rewrite: the OLDEST large tool
  // results collapse to a short head + marker, freeing budget for further
  // exploration. Recent rounds are always kept intact — they're what the model
  // is actively reasoning over.
  interface ToolResultLogEntry {
    msgIndex: number;
    name: string;
    round: number;
    chars: number;
    compacted: boolean;
  }
  const toolResultLog: ToolResultLogEntry[] = [];
  const COMPACT_PRESSURE_THRESHOLD = Math.floor(MAX_TOTAL_TOOL_CHARS * 0.7);
  const KEEP_RECENT_ROUNDS = 2; // never compact the last N rounds' results
  const COMPACT_MIN_CHARS = 600; // small results aren't worth rewriting
  const COMPACT_HEAD_CHARS = 200; // keep the head (file path, match count…) as an anchor

  const recordToolResult = (name: string, round: number, content: string) => {
    toolResultLog.push({ msgIndex: messages.length - 1, name, round, chars: content.length, compacted: false });
  };

  const compactOldToolResults = (currentRound: number): void => {
    if (toolCharsUsed < COMPACT_PRESSURE_THRESHOLD) return;
    for (const entry of toolResultLog) {
      if (entry.compacted || entry.chars < COMPACT_MIN_CHARS) continue;
      if (entry.round > currentRound - KEEP_RECENT_ROUNDS) continue;
      const msg = messages[entry.msgIndex];
      const head = String(msg.content).slice(0, COMPACT_HEAD_CHARS);
      msg.content = head + '…[older ' + entry.name + ' result compacted to save context — call the tool again if you still need it]';
      toolCharsUsed -= Math.max(0, entry.chars - msg.content.length);
      entry.compacted = true;
    }
  };

  const emitMetrics = () => {
    parentPort?.postMessage({
      type: 'metrics',
      wallMs: Date.now() - runStarted,
      turns: perTurn.length,
      apiCalls: apiCallsTotal,
      promptTokens: promptTokensTotal,
      completionTokens: completionTokensTotal,
      totalTokens: promptTokensTotal + completionTokensTotal,
      usageMissingTurns,
      toolCallsExecuted,
      writesApplied,
      failedToolCalls: [...failedCalls.values()].reduce((a, b) => a + b, 0),
      toolCharsUsed,
      budgetExhausted,
      compactions: toolResultLog.filter((e) => e.compacted).length,
      exploration: explorationStats,
      nudges: {
        plan: planNudgesUsed,
        incompleteAnswer: incompleteAnswerNudgesUsed,
        failedWrites: failedWritesNudgeUsed ? 1 : 0,
        phantomChanges: phantomChangesNudgesUsed,
        summary: summaryNudgeUsed ? 1 : 0,
        completenessReflectionUsed,
        autoDiagnosticsRan,
      },
      slowModelMode,
      iterationCap,
      perTurn,
    });
  };

  // ── Exploration decomposition (pre-loop) ──
  // For questions whose answer is spread across several parts of the repo,
  // read the bulk of that spread here — via disposable, tool-less explorer
  // completions that are paid once and discarded — instead of letting the
  // main loop accumulate raw file dumps in `messages` across many rounds.
  // Deterministic scout/cluster/merge; the model is only ever asked to
  // answer, never to plan the split. See EXPLORATION-DECOMPOSITION-DESIGN.md.
  // Best-effort throughout: any failure here falls through to the loop below
  // running exactly as it does today.
  const exploreStarted = Date.now();
  const exploration = await runExplorationPhase(
    prompt,
    model,
    baseURL,
    apiKeys,
    {
      requestTool,
      onProgress: (label) => {
        const id = randomUUID();
        parentPort?.postMessage({ type: 'tool_status', id, name: 'explore_codebase', arguments: { label } });
      },
      notifyRotate: notifyKeyFailover,
    },
    {
      ...defaultExplorationConfig(isLocalProvider),
      // Same rationale as runToolTurn: explorers have a 600-token output cap,
      // which unconstrained reasoning burns entirely on thinking.
      ...(isOpenRouter ? { extraBody: { reasoning: { effort: 'low' } } } : {}),
    },
    isLocalProvider
  );
  const exploreMs = Date.now() - exploreStarted;
  explorationStats = exploration.stats;
  // Explorers run in parallel, so phase wall-time ≈ ONE completion's latency
  // (the scout part is local ripgrep, milliseconds). A slow — or timed-out —
  // phase is the earliest possible evidence of a slow model: degrade before
  // the main loop burns 25 minute-long turns. Skipped when the phase made no
  // API calls quickly (gate declined: that says nothing about the model).
  if (exploreMs > SLOW_TURN_MS) {
    enterSlowMode(exploreMs, 0);
  }
  if (exploration.stats.apiCalls > 0) {
    apiCallsTotal += exploration.stats.apiCalls;
    promptTokensTotal += exploration.stats.promptTokens;
    completionTokensTotal += exploration.stats.completionTokens;
  }
  if (exploration.claimTableMarkdown) {
    // Carried as a plain user turn, NOT as a synthetic assistant tool_call +
    // tool result pair. `explore_codebase` is not a declared tool (it isn't in
    // TOOL_DEFS — the phase runs as plain code, the model never calls it), and
    // referencing an undeclared function in the history is invalid under the
    // OpenAI tool schema: a provider validating names against the declarations
    // it was sent has nothing to match. A user turn carries the same text with
    // no schema claim attached, so no validator can object.
    const claimContent =
      'Preliminary scan of the workspace (done for you before this turn):\n\n' +
      exploration.claimTableMarkdown +
      '\n\n(These are cited leads from a preliminary scan, not verified truth. Open any cited range ' +
      'with read_file before relying on it for an edit. Unexplored files above are just names — ' +
      'investigate them with tools if the question requires it.)';
    messages.push({ role: 'user', content: claimContent });
    // Deliberately NOT passed through recordToolResult: this table is the map
    // for the whole run and must survive microcompaction, which only rewrites
    // entries present in toolResultLog. It still counts against the budget.
    toolCharsUsed += claimContent.length;
  }

  for (let i = 0; i < iterationCap; i++) {
    const turnStarted = Date.now();
    const outcome = await runToolTurn(messages, model, baseURL, apiKeys, true);
    const thoughtMs = Date.now() - turnStarted;

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
    noteTurn(thoughtMs, outcome, toolCalls.length, salvaged);
    maybeEnterSlowMode(i);

    if (toolCalls.length === 0) {
      // The model wants to finish — but unverified writes block that. Run
      // get_diagnostics OURSELVES as a synthetic tool exchange (deterministic,
      // unlike nudging): the model then sees the result and either confirms or
      // fixes what it broke. Once per run — a model that ignores the result
      // shouldn't loop forever.
      if (writesSinceDiagnostics > 0 && !autoDiagnosticsRan) {
        autoDiagnosticsRan = true;
        const diagCallId = 'auto_diagnostics_check';
        messages.push({
          role: 'assistant',
          content: outcome.content || null,
          tool_calls: [{ id: diagCallId, type: 'function', function: { name: 'get_diagnostics', arguments: '{}' } }],
        });
        const diagTransportId = randomUUID();
        parentPort?.postMessage({ type: 'tool_status', id: diagTransportId, name: 'get_diagnostics', arguments: { auto: true } });
        let diagResult: unknown;
        try {
          diagResult = await requestTool('get_diagnostics', {}, diagTransportId);
        } catch (e) {
          diagResult = { error: e instanceof Error ? e.message : String(e) };
        }
        messages.push({ role: 'tool', tool_call_id: diagCallId, content: serializeToolResult(diagResult) });
        recordToolResult('get_diagnostics', i, messages[messages.length - 1].content);
        writesSinceDiagnostics = 0;
        continue;
      }
      // Everything attempted so far errored → the model has zero facts from
      // the workspace and any answer is fabricated. Redirect once.
      if (toolCallsExecuted > 0 && okToolResults === 0 && !allErrorsNudgeUsed && !budgetExhausted) {
        allErrorsNudgeUsed = true;
        // The draft conclusion is UNGROUNDED by definition here (zero successful
        // results) — echoing it back anchors weak models, which then restate it
        // even after later tool calls return contradicting data (observed:
        // "add is not found" survived two search_codebase calls full of hits).
        // Replace it with a neutral placeholder instead of preserving it.
        messages.push({ role: 'assistant', content: '(answer withheld — no successful tool results yet)' });
        messages.push({
          role: 'user',
          content:
            'STOP: every tool call you made so far FAILED — you have gathered zero actual information from the workspace, so any conclusion you have drawn is void; discard it. You cannot answer yet, and especially cannot claim something does not exist. ' +
            'Read the error messages: they say which tool to use instead. Call search_codebase with a text query now (try outputMode "files_with_matches" first), use REAL arguments taken from actual results — never placeholder strings like "<path-to-file>" — then answer ONLY from what the tools return.',
        });
        continue;
      }
      // A file whose LAST write attempt failed means the task is incomplete —
      // models routinely declare success anyway ("renamed across the project"
      // while math.js was never touched, observed live). Confront once.
      const failedPaths = [...lastWriteOutcome.entries()].filter(([, ok]) => !ok).map(([p]) => p);
      if (failedPaths.length > 0 && !failedWritesNudgeUsed) {
        failedWritesNudgeUsed = true;
        messages.push({ role: 'assistant', content: outcome.content || '(empty response)' });
        messages.push({
          role: 'user',
          content:
            `STOP: your last edit to ${failedPaths.join(', ')} FAILED — the file was NOT changed and the task is NOT complete. ` +
            'Re-read the file, retry the edit with an exact snippet from the read result, or state explicitly that this file could not be updated. Do not claim it was changed.',
        });
        continue;
      }
      // Zero write calls all run, yet the answer narrates completed changes
      // ("Changes Made: renamed..."): the model role-played the task instead
      // of doing it — observed live with qwen writing a full markdown story of
      // edits it never attempted. Confront once.
      const claimsChanges =
        /\b(changes made|i (have )?(successfully )?(changed|renamed|updated|modified|created|fixed)|(has|have) been (\w+ly )?(changed|renamed|updated|modified|created|fixed)|were (\w+ly )?(changed|renamed|updated)|successfully (changed|renamed|updated|modified|created|fixed))\b/i.test(
          outcome.content
        );
      if (writesApplied === 0 && claimsChanges && phantomChangesNudgesUsed < 2) {
        phantomChangesNudgesUsed++;
        // Confront with EVIDENCE, not just exhortation: a live git_status
        // showing a clean tree is harder to role-play past than a scolding.
        let treeEvidence = '';
        try {
          const st = (await requestTool('git_status', {}, randomUUID())) as { status?: string } | null;
          if (st?.status) treeEvidence = ` git_status proves it — the working tree reads:\n${String(st.status).slice(0, 500)}\n`;
        } catch {
          /* evidence is optional */
        }
        messages.push({ role: 'assistant', content: outcome.content });
        messages.push({
          role: 'user',
          content:
            'STOP: you claim changes were made, but no edit was ever APPLIED — NOTHING in the workspace has actually changed.' +
            treeEvidence +
            'If the task requires changing files, make the changes NOW: read_file the target, then call edit_file with oldString copied exactly. ' +
            'Otherwise, rewrite your answer without claiming any change was made. Do not apologize and repeat the claim.',
        });
        continue;
      }
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
      // An answer that announces remaining work ("cloudwatch.tf needs to be
      // examined to see the schedule") is a partial answer, not a final one —
      // the model is asking the user to type "continue". Send it back to
      // finish the job itself. Skipped once the tool budget is gone: at that
      // point continuing is impossible and a partial answer is the best we have.
      if (
        !budgetExhausted &&
        INCOMPLETE_ANSWER_RE.test(outcome.content) &&
        incompleteAnswerNudgesUsed < MAX_PLAN_NUDGES
      ) {
        incompleteAnswerNudgesUsed++;
        messages.push({ role: 'assistant', content: outcome.content });
        messages.push({
          role: 'user',
          content:
            'Your answer says something still needs to be examined or checked — do NOT stop to announce remaining work, and do NOT wait for the user to say "continue". ' +
            'Do the remaining examination NOW with your tools, then give ONE complete final answer that includes what you find.',
        });
        continue;
      }
      // One-shot completeness reflection before accepting a tool-grounded
      // answer (see completenessReflectionUsed above). The nudged turn passes
      // back through every gate here, so a reflection that surfaces new work
      // still gets diagnostics/honesty checks before the run can end.
      if (
        !completenessReflectionUsed &&
        // Optional polish, not an honesty gate — on a slow model this extra
        // round trip costs another minute and is the first thing to drop.
        !slowModelMode &&
        !budgetExhausted &&
        toolCallsExecuted > 0 &&
        outcome.content.trim()
      ) {
        completenessReflectionUsed = true;
        messages.push({ role: 'assistant', content: outcome.content });
        // A run that changed (or tried to change) files gets a write-oriented
        // reflection: the dominant incompleteness is a partially-propagated change —
        // definition renamed but exports/call sites left stale (observed live:
        // qwen renamed `add` to `sum` in the definition and imports, left
        // `module.exports = { add, ... }` and every `add(...)` call untouched,
        // and get_diagnostics is syntax-only so it stayed green). The Q&A
        // reflection below can't catch that.
        if (writesApplied > 0 || anyWriteAttempted) {
          messages.push({
            role: 'user',
            content:
              'Before this is accepted: verify your changes are COMPLETE, not just applied. ' +
              'If you renamed or replaced a symbol, run search_codebase for the OLD name NOW — every remaining match (definition, module.exports/export lines, imports/requires, call sites) must be updated or explicitly justified. ' +
              'If the task involves a test, build, or command, re-run it now and confirm it actually succeeds — clean diagnostics alone do not prove runtime behavior. ' +
              'Fix anything incomplete, then give your final answer. If everything is genuinely complete, return your answer again unchanged.',
          });
          continue;
        }
        messages.push({
          role: 'user',
          content:
            'Before this is accepted: re-read the original question and check your answer covers ALL of it. ' +
            'Common gap: questions like "how is X triggered/used/configured/deployed" usually have SEVERAL answers — an app can have event subscriptions, schedules, queue consumers, HTTP endpoints, AND manual/CLI invocations at the same time; you may have described only the first one you found. ' +
            'Check the app\'s full configuration (serverless.yml, terraform/*.tf, package.json scripts) for mechanisms you did not mention. ' +
            'If something is missing, verify it with tools NOW and give the complete answer. If your answer already covers everything, return it again unchanged.',
        });
        continue;
      }
      // Any turn that ran tools deserves at least a one-line report — an empty
      // "done" after edits (or after exploration that led nowhere) looks like
      // a hang, or worse, silently reads as success once the webview's
      // fallback text papers over it (observed live: a search-only turn found
      // no conclusive match, wrote nothing, and returned empty content).
      if (!outcome.content.trim() && toolCallsExecuted > 0 && !summaryNudgeUsed) {
        summaryNudgeUsed = true;
        messages.push({ role: 'assistant', content: '(empty response)' });
        messages.push({
          role: 'user',
          content:
            writesApplied > 0
              ? 'You applied file changes but returned no answer. In 1-2 sentences, state what you changed and whether diagnostics are clean. Do not call more tools unless something is broken.'
              : 'You ran tools but returned no answer. In 1-2 sentences, state what you found, and if you did not find enough to complete the task, say so explicitly and name what is still missing. Do not call more tools unless something is broken.',
        });
        continue;
      }
      if (outcome.content) parentPort?.postMessage({ type: 'chunk', content: outcome.content });
      emitMetrics();
      parentPort?.postMessage({ type: 'done', content: outcome.content });
      return;
    }

    // The model paused to "think" between tool batches — surface it like the
    // step timeline expects ("Thought for 2s"), then any prose it wrote
    // alongside its tool calls (previously swallowed into `messages` only).
    parentPort?.postMessage({ type: 'thought', ms: thoughtMs });
    if (!salvaged && outcome.content.trim()) {
      parentPort?.postMessage({ type: 'agent_note', content: outcome.content.trim() });
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

    // Reads are safe to run concurrently (each is a main-thread round trip).
    // Turns containing ANY mutating call run strictly sequentially instead:
    // several edits prepared against the same original file content invalidate
    // each other on apply ("changed since the edit was prepared"), and a
    // run_command racing an edit tests stale code — both observed live with
    // qwen2.5-coder, which happily emits 7 edits in one turn.
    // Relieve token pressure BEFORE running this round's tools, so their
    // results land in freed space instead of being truncated to nothing.
    compactOldToolResults(i);

    const hasMutation = toolCalls.some((tc) => MUTATING_TOOL_NAMES.has(tc.name));
    const executeOne = async (tc: BufferedToolCall) => {
      let parsedArgs: unknown = {};
      try {
        parsedArgs = tc.args ? JSON.parse(tc.args) : {};
      } catch {
        parsedArgs = {};
      }
      const callKey = `${tc.name}:${tc.args}`;
      const priorFailures = failedCalls.get(callKey) ?? 0;
      if (priorFailures >= 1) {
        // Identical call already failed — don't execute it again, escalate.
        failedCalls.set(callKey, priorFailures + 1);
        return {
          error:
            `You already made this exact ${tc.name} call and it failed the same way. Repeating it verbatim will always fail. ` +
            (tc.name === 'edit_file'
              ? 'Change the call: re-read the file, then copy a LARGER exact snippet — including the enclosing function/JSX line above your target — as oldString.'
              : 'Change the arguments or take a different approach.'),
        };
      }
      // Placeholder-argument guard: weak models emit template values like
      // "<file_path>" or "<path-to-add-definition>" instead of substituting
      // real values from prior results — observed repeatedly: after a
      // files_with_matches result LISTING the real paths, qwen looped
      // read_file/edit_file calls on the literal string "<file_path>".
      // ENOENT errors didn't break the loop; naming the disease does.
      const placeholderEntry = Object.entries((parsedArgs ?? {}) as Record<string, unknown>).find(
        ([, v]) => typeof v === 'string' && /^<[^<>]{1,80}>$/.test(v.trim())
      );
      if (placeholderEntry) {
        failedCalls.set(callKey, priorFailures + 1);
        return {
          error:
            `You passed the literal placeholder ${JSON.stringify(placeholderEntry[1])} as "${placeholderEntry[0]}" — placeholders are never valid arguments. ` +
            'Substitute a REAL value taken from a previous tool result (e.g. an actual path from the files list you already received), and make one call per real target.',
        };
      }
      const transportId = randomUUID();
      parentPort?.postMessage({ type: 'tool_status', id: transportId, name: tc.name, arguments: parsedArgs });
      // Read-before-edit guard: don't execute an edit against a file the model
      // has never seen — fetch the file ourselves and return it in the error,
      // so the retry is a copy job instead of another guess. If the read fails
      // (bad path), fall through: edit_file's own "File not found" is clearer.
      if (tc.name === 'edit_file') {
        const target = normPath((parsedArgs as { path?: unknown } | null)?.path);
        if (target && !readPaths.has(target)) {
          try {
            const readResult = (await requestTool('read_file', { path: target }, randomUUID())) as { content?: string } | null;
            let content = String(readResult?.content ?? '');
            if (content.length > EDIT_UNREAD_CONTENT_CAP) {
              content = content.slice(0, EDIT_UNREAD_CONTENT_CAP) + '\n…[truncated — read_file the specific line range you need]';
            }
            // Deliberately NOT counted in failedCalls: an identical retry now
            // has the file in readPaths and deserves a real execution (where
            // prepareEditFile's whitespace-tolerant fallback may still apply).
            readPaths.add(target);
            return {
              error:
                `Edit not executed: you have not read ${target} in this session, so your oldString is written from memory and will not match. ` +
                `Here is the CURRENT content of ${target} — retry the edit with oldString copied from it character-for-character:\n\`\`\`\n${content}\n\`\`\``,
            };
          } catch {
            // Unreadable target — let edit_file produce its own error below.
          }
        }
      }
      try {
        const result = await requestTool(tc.name, parsedArgs, transportId);
        if (tc.name === 'read_file' || tc.name === 'create_file') {
          const p = normPath((parsedArgs as { path?: unknown } | null)?.path);
          if (p) readPaths.add(p);
        }
        return result;
      } catch (e) {
        failedCalls.set(callKey, priorFailures + 1);
        return { error: e instanceof Error ? e.message : String(e) };
      }
    };
    const results: unknown[] = [];
    if (hasMutation) {
      for (const tc of toolCalls) results.push(await executeOne(tc));
    } else {
      results.push(...(await Promise.all(toolCalls.map(executeOne))));
    }

    // `role: 'tool'` messages must immediately and contiguously follow the
    // assistant `tool_calls` turn that requested them — several OpenAI-compat
    // backends (observed: GMI/MiniMax) reject the request with "tool call
    // result does not follow tool call" if anything else is interleaved
    // between them. A ticket's images can't ride in a tool message (plain
    // string content only), so their follow-up user turn is queued here and
    // only pushed once every tool result for this round is in place.
    const pendingImageTurns: { role: 'user'; content: unknown }[] = [];
    toolCalls.forEach((tc, idx) => {
      const rawResult = results[idx];
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: serializeToolResult(stripImagesForToolText(tc.name, rawResult)),
      });
      recordToolResult(tc.name, i, messages[messages.length - 1].content);

      const ticketImages = (rawResult as { images?: { dataUrl: string }[] } | null)?.images;
      if (tc.name === 'get_ticket' && ticketImages?.length) {
        const ticketId = (rawResult as { id?: unknown } | null)?.id ?? '';
        pendingImageTurns.push({
          role: 'user',
          content: [
            { type: 'text', text: `Image(s) attached to ticket #${ticketId}:` },
            ...imagesToContentParts(ticketImages),
          ],
        });
      }

      const failed = !!(results[idx] as { error?: unknown } | null)?.error;
      if (!failed) okToolResults++;
      if (FILE_WRITE_TOOL_NAMES.has(tc.name)) {
        anyWriteAttempted = true;
        if (!failed) {
          writesApplied++;
          writesSinceDiagnostics++;
        }
        try {
          const p = (JSON.parse(tc.args || '{}') as { path?: string }).path;
          if (p) lastWriteOutcome.set(p, !failed);
        } catch {
          /* unparseable args — nothing to track */
        }
      }
      if (tc.name === 'get_diagnostics') writesSinceDiagnostics = 0;
    });
    messages.push(...pendingImageTurns);
    toolCallsExecuted += toolCalls.length;
    if (budgetExhausted) {
      // Before treating exhaustion as terminal, try compacting older results —
      // if that frees enough room for at least one more full-size result, the
      // exploration can continue instead of being cut off mid-trace.
      compactOldToolResults(i);
      if (MAX_TOTAL_TOOL_CHARS - toolCharsUsed >= MAX_TOOL_RESULT_CHARS) {
        budgetExhausted = false;
      }
    }
    if (budgetExhausted) break;
  }

  // Either MAX_TOOL_ITERATIONS or the tool-output budget was hit: force a
  // final answer without tools so the user always gets a response instead of
  // hanging or erroring.
  let finalStarted = Date.now();
  let finalOutcome = await runToolTurn(messages, model, baseURL, apiKeys, false);
  noteTurn(Date.now() - finalStarted, finalOutcome, 0, false);
  if (!finalOutcome.content.trim()) {
    // Empty even after runToolTurn's own reasoning-budget retry — give it one
    // more explicit nudge before giving up, since a forced no-tools turn with
    // a long tool-result history is exactly the shape that starves smaller
    // output budgets.
    messages.push({ role: 'assistant', content: '(empty response)' });
    messages.push({
      role: 'user',
      content: `Answer now, in plain prose, using the ${toolCallsExecuted} tool result(s) already gathered above. Do not call any more tools.`,
    });
    finalStarted = Date.now();
    finalOutcome = await runToolTurn(messages, model, baseURL, apiKeys, false);
    noteTurn(Date.now() - finalStarted, finalOutcome, 0, false);
  }
  if (!finalOutcome.content.trim()) {
    // Still nothing — telling the user "Done" here would be a lie (nothing
    // was answered, and if writesApplied === 0, nothing changed either). Say
    // so plainly instead of letting the webview's generic fallback text imply
    // the task succeeded.
    emitMetrics();
    parentPort?.postMessage({
      type: 'error',
      message:
        `The model returned no answer after ${toolCallsExecuted} tool call(s). ` +
        (budgetExhausted
          ? 'It exhausted the tool-output budget before finishing its exploration — try narrowing the question.'
          : 'It likely spent its whole output budget on internal reasoning — try a model with a larger max-output limit, or narrow the question.'),
    });
    return;
  }
  parentPort?.postMessage({ type: 'chunk', content: finalOutcome.content });
  emitMetrics();
  parentPort?.postMessage({ type: 'done', content: finalOutcome.content });
}

// Start processing
generateResponse();
