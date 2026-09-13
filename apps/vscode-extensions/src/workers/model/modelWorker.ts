import { parentPort, workerData } from 'worker_threads';
import { randomUUID } from 'crypto';
import { createStructuredPrompt, createContinuationPrompt, isResearchWorkItem, TicketPromptContext } from '../../utils/promptTemplates';
import { MODEL_PROVIDERS, REMOTE_MODEL } from '../../../constants';
import OpenAI from 'openai';
import { EmbeddingSearchResult } from 'src/types/types';
import { withKeyFailover } from '../../utils/apiKeyFailover';
import { extractBalancedJsonObjects } from './jsonExtract';
import { runExplorationPhase, defaultExplorationConfig } from './explorationPhase';
import { runExploreSubagent, defaultExploreConfig, EXPLORE_TOOL_NAMES } from './exploreSubagent';
import {
  INCOMPLETE_ANSWER_RE,
  PERMISSION_SEEKING_RE,
  CHANGE_PLAN_RE,
  PREMATURE_AMBIGUITY_RE,
  TICKET_TERMINAL_RE,
  isUnbackedCompletionClaim,
  REPORT_SHAPED_RE,
  stripReportPreamble,
  IMPLEMENT_MANDATE_RE,
  CLAIMS_CHANGES_RE,
  MISSING_TOOL_CLAIM_RE,
  extractAnswerFilePaths,
  isStallShapedAnswer,
  resolveHarnessProfile,
  phraseGatesEnabled,
  commitNudgeTriggers,
  hasWriteIntent,
  isUnfinishedWriteRun,
  writeWasExpected,
} from './answerGates';
import { normalizeModelId } from '../../utils/normalizeModelId';
import { getProviderDefaultHeaders } from '../../utils/anthropicHeaders';
import { consumeStream, shouldRetryEmptyStream } from './streamOutcome';
import { scopeToolDefs, ToolAvailability } from './toolScope';
import {
  contextState,
  isStagnant,
  observedWindowFloor,
  resolveContextWindow,
} from './contextBudget';
import { contextBreakdown } from './contextBreakdown';
import {
  COMMIT_NARROWED_NOTICE,
  DISCOVERY_TOOL_NAMES,
  VERIFICATION_RESERVE_TURNS,
  capWithVerificationReserve,
  narrowToCommitTools,
  shouldNarrowToConclude,
} from './writePressure';
import {
  EMPTY_RESPONSE_PLACEHOLDER,
  HARNESS_CHECKPOINT_PREFIX,
  HARNESS_LIMIT_PHRASE,
  HARNESS_LIMIT_PREFIX,
  HARNESS_PROSE_RETRY_PREFIX,
  LimitKind,
  pruneStaleHarnessMessages,
} from './resumeHygiene';
import { AutoVerifyTracker, CheckResultLike, CheckKindName, PendingCheck } from './autoVerify';
import { stripLineNumbers } from '../../services/codebase/lineNumbers';

interface WorkerData {
  prompt: string;
  searchResults: EmbeddingSearchResult[];
  modelId?: string;
  chatHistory?: string;
  /**
   * The webview chat session this turn belongs to — stable across every turn
   * of one conversation. Sent to the provider as its prompt-cache / sticky
   * routing key (see PROMPT_CACHE_FIELDS); never used for anything else.
   */
  sessionId?: string;
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
  /**
   * Which tool groups this turn may be offered, from facts the host checked
   * (folder open, source authenticated). Absent on an older host: every tool.
   */
  toolAvailability?: ToolAvailability;
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
  /**
   * This turn carries out a plan the user just approved, so it is expected to
   * WRITE. Switches the prompt out of plan mode and arms the gate that catches
   * an answer which re-proposes instead of executing.
   */
  executeMandate?: boolean;
  /**
   * Model-facing messages (tool calls and their results included) of a previous
   * agent turn in this session that was interrupted before it produced an
   * answer. When present, the loop continues that conversation instead of
   * rebuilding one from scratch — see runAgentLoop's seedFromTranscript.
   */
  resumeTranscript?: unknown[];
  /**
   * The work item this turn is about, pre-fetched live from Azure DevOps by
   * the host (the message named a ticket ID). Grounds BOTH the exploration
   * phase's scout (the ticket body carries the discriminating vocabulary the
   * prompt lacks) and the prompt itself (acceptance criteria = definition of
   * done). Images from the ticket ride separately in imageAttachments.
   */
  ticketContext?: TicketPromptContext;
  /**
   * Click-to-run mode: no human is watching. Writes are auto-applied host-side,
   * permission-seeking is a failure, and the code-enforced verification gate
   * gets extra bounded retries instead of one.
   */
  autonomous?: boolean;
  /**
   * Overrides the harness profile this run would otherwise get from its
   * provider (see resolveHarnessProfile). Exists so the eval harness can run
   * the same task under both.
   */
  harnessProfile?: 'small-model' | 'strong-model';
  /**
   * Files changed by EARLIER turns of this chat session, host-tracked. Lets
   * the delivery-time honesty stamp tell a fabricated completion report apart
   * from a truthful recap of a previous turn's real edits — both have zero
   * writes of their own.
   */
  priorWrites?: number;
  /**
   * Plan mode: this turn's deliverable IS a plan — investigate with read
   * tools, propose exact edits, do not write. Disarms the anti-plan gates
   * (plan-instead-of-execute, ticket-completion, permission-seeking, force-
   * read) whose whole job is to punish exactly that shape of answer.
   */
  planMode?: boolean;
  /**
   * Context window in tokens, when the host knows it better than
   * contextBudget.ts can infer from the model id. Absent: inferred, then
   * self-corrected from prompts the provider accepts.
   */
  contextWindowOverride?: number;
}

const {
  prompt,
  searchResults,
  modelId,
  chatHistory,
  sessionId,
  provider,
  apiKey,
  apiKeys,
  baseUrl,
  currentUserName,
  currentSprint,
  codebaseTools,
  toolAvailability,
  textAttachments,
  imageAttachments,
  mentionedFiles,
  repoOrientation,
  workspaceRules,
  contextWindowOverride,
  executeMandate,
  resumeTranscript,
  ticketContext,
  autonomous,
  planMode,
  priorWrites,
  harnessProfile,
} = workerData as WorkerData;

// Prefer the full key list; fall back to the single legacy key.
const failoverKeys = apiKeys && apiKeys.length ? apiKeys : apiKey ? [apiKey] : [];

/**
 * Per-request retry budget for the OpenAI SDK clients this worker builds.
 * The SDK retries 408/409/429/5xx itself; its default of 2 gives about 1.5
 * seconds of backoff, which is not enough to survive a provider hiccup
 * mid-run. Sustained outages are handled by withKeyFailover.
 */
const MODEL_CLIENT_MAX_RETRIES = 4;

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

/**
 * Every image dataUrl already somewhere in the conversation, so no screenshot
 * is sent to the model twice.
 *
 * Seeded from `imageAttachments`, which on a ticket run ALREADY carries the
 * ticket's first two screenshots (chatService prefetches them alongside the
 * user's own attachments). When the model then calls `get_ticket`, the same
 * images come back in the tool result and used to be pushed again as a
 * follow-up user turn — so the request carried both screenshots twice, on
 * every turn of the loop. Base64 screenshots are the largest single thing in
 * that payload; the duplicate was pure cost, and it grew the request in
 * exactly the direction that makes a provider more likely to reject it.
 *
 * Membership is by dataUrl rather than by name because names are not unique
 * across work items, and the dataUrl is what actually gets billed.
 */
const sentImageDataUrls = new Set<string>((imageAttachments ?? []).map((img) => img.dataUrl));

/**
 * Filters `images` down to the ones not yet in the conversation, recording
 * them as sent. Filtering rather than skipping the whole batch matters: only
 * the first two ticket images are prefetched, so a ticket with four still
 * needs the other two — and a second `get_ticket` call for the same ticket
 * now adds nothing instead of resending everything.
 */
function unsentImages<T extends { dataUrl: string }>(images: T[]): T[] {
  const fresh = images.filter((img) => img?.dataUrl && !sentImageDataUrls.has(img.dataUrl));
  for (const img of fresh) sentImageDataUrls.add(img.dataUrl);
  return fresh;
}

/**
 * Statuses that mean "the request as SHAPED was refused", so changing the
 * shape is worth one attempt before the run dies. Everything else is about
 * the endpoint or the account — 401/403 auth, 404 route, 429 rate, 5xx — and
 * no edit to the messages can cure those.
 */
const REQUEST_SHAPE_REJECTED = new Set([400, 413, 422]);

/**
 * Whether a failed request is worth retrying with the images removed.
 *
 * Keyed on the STATUS, plus whether the conversation actually carries images
 * (the caller checks that by seeing if stripping changed anything).
 * Deliberately NOT keyed on the provider's wording — two incidents in the
 * same direction taught that:
 *   · Gemini rejects image content it can't use with a completely EMPTY 400
 *     body: the SDK reports only "400 status code (no body)", so there is no
 *     prose to match at all.
 *   · z-ai/glm-5.3-free via TokenRouter (2026-09-07) rejected a ticket's two
 *     screenshots with "Failed to deserialize the JSON body into the target
 *     type: `content` must be a string, or an array of content parts …". The
 *     old gate required one of invalid/not support/unsupported/vision in that
 *     text, found none, and the strip-and-retry never fired — a 7-step
 *     autonomous run died one image away from succeeding.
 *
 * Every provider phrases a rejection differently and rewords it without
 * notice, so this was never a matter of pattern accuracy: a miss costs the
 * WHOLE RUN, a false positive costs ONE extra request. Direction of failure
 * over accuracy of pattern — so retry whenever images are present and the
 * status says the body was the problem.
 */
function shouldRetryWithoutImages(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  return REQUEST_SHAPE_REJECTED.has(status);
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
      name: 'explore',
      description:
        'Delegate a QUESTION about the codebase to a read-only investigator that searches and reads on its own budget, and returns a short list of findings with file:line citations. Its file contents never enter your context — you get the conclusions, not the files.\n' +
        'Reach for it when answering something would mean opening more than about three files you have not read: "where is the rejection status decided and who writes it", "which of these four hooks writes to storage", "what does this mapper actually receive on first render". One call replaces that whole survey.\n' +
        'Do NOT use it for a file you already know you need — read_file that directly. It cannot change anything, and its findings are leads: open the exact range it cites before you edit against it. If it reports nothing citable, investigate yourself.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'One specific question, phrased so a short factual answer settles it. Not a task ("fix the mapper") and not a topic ("the mapper") — a question ("which mapper overwrites the rejected status, and where is it called from?").',
          },
          scope: {
            type: 'string',
            description: 'Optional hint about where to start — a directory, a package, or a symbol name.',
          },
        },
        required: ['question'],
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
      description:
        'Read a file in the workspace, optionally restricted to a line range. Returns up to 2000 lines (64 KB) per call, so most files come back whole in ONE call — do not page through a file in 400-line slices. ' +
        'Every line is prefixed with its number as `  12→code`; cite those numbers directly as `path/to/file.ts:L12-L20` in your answer. When you copy code into `edit_file`\'s oldString, copy the code only, WITHOUT the `12→` prefix (if you leave it on, the harness strips it for you and says so). ' +
        'Reading several files is one turn, not several: issue all the read_file calls you need together and they run in parallel. The result also reports `startLine`/`endLine` and `totalLines`, so a follow-up call can name the exact next range instead of re-reading from the top.',
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
              'Work item ID as the user wrote it — any prefix is tolerated ("1234", "TKT-1234", "#1234"), and a full work-item URL ("https://dev.azure.com/{org}/{project}/_workitems/edit/1234") also works.',
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
      name: 'get_confluence_page',
      description:
        'Read ONE Confluence page by id or URL, live from Confluence (always current — the synced docs index used by search_docs may be stale). Use this whenever the user names or pastes a specific Confluence page rather than asking a general question the semantic index can answer.',
      parameters: {
        type: 'object',
        properties: {
          pageId: {
            type: 'string',
            description: 'Confluence page id, or a full page URL — the id will be extracted.',
          },
        },
        required: ['pageId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        "Live web search for anything the codebase and org docs can't answer — an unfamiliar library/API/product, current documentation, or something that changed since training. Use it when a name or concept is unrecognized rather than guessing. Returns a synthesized answer (when available) plus source snippets with URLs — cite the URLs when you use them. Without a Tavily key configured, this falls back to a lower-reliability public search — don't over-trust unlabeled results in that mode. Never use this for Azure DevOps or Confluence links — it cannot reach private instances; use get_ticket/get_confluence_page (they take a URL directly) or search_tickets/search_docs instead.",
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
        'Run a shell command in the workspace (build, test, lint, package scripts). Returns exit code and combined stdout+stderr (already truncated) — pass ONE plain command, never pipes, "2>&1", "| tail", "&&" or "cd x &&" (use the cwd parameter instead). The user approves each command before it runs (previously session-approved commands run immediately); destructive commands are blocked outright. Use this to VERIFY your edits — run the relevant test/build after changing code.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run, e.g. "npm test -- --run" or "npx tsc --noEmit".' },
          description: { type: 'string', description: 'REQUIRED. What this command is for, 3-6 words, sentence case, no trailing period — e.g. "Run the checkout step tests", "Typecheck the webview". This is the label the user sees in the run timeline; the raw command is shown only when they expand the row. Write it for someone who does not read shell.' },
          cwd: { type: 'string', description: 'Workspace-relative working directory. Defaults to the first workspace root; in a multi-root workspace prefix it with the root folder name ("my-repo" or "my-repo/apps/web") to run inside that root. Package-manager commands (pnpm --filter, npm run) must run from the repo that owns the package.' },
          timeoutSec: { type: 'number', description: 'Kill the command after this many seconds (default 60, max 300).' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_checks',
      description:
        'Run the tests, lint, or typecheck that cover ONE FILE — the host derives the command itself: the nearest package, its package manager (pnpm/npm/yarn/bun), its runner (jest/vitest/eslint/tsc or the package script), the sibling test file, and the right working directory. Prefer this over run_command for verification: it cannot pick the wrong directory or an unapproved command, and autonomous runs execute it without a gate. Call it with kind "lint", "typecheck" and "test" for every source or test file you changed; FIX failures before declaring the task done. If you skip it, the run does it FOR you before your answer is accepted — the failures land in your transcript either way, so run it yourself while you still have the context to fix them. Re-running the same derived command without changing a file first replays the previous result instead of running again. Returns the exact command it ran, exit code and output.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path of the source or test file to verify (root-prefixed in a multi-root workspace).' },
          kind: { type: 'string', enum: ['test', 'lint', 'typecheck'], description: 'Which check to run. Defaults to "test".' },
        },
        required: ['path'],
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
        'Replace text in a workspace file. Make ONE call per file: put every change to that file in `edits` (applied in order, all-or-nothing) instead of one call per change. Each oldString must be copied character-for-character from the read_file output MINUS its `12→` line-number prefixes — KEEP the original line breaks and indentation, NEVER collapse multiple lines onto one line or retype code from memory — and must appear exactly once. A short line like "return a + b;" often occurs in SEVERAL functions: make oldString the WHOLE enclosing block from its header line down (e.g. the full function), so the match is unique on the first try. Set replaceAll only to change every occurrence. For a single change you may pass oldString/newString at the top level instead of edits. The user reviews and approves each edit before it is applied; a rejection comes back as an error with their feedback.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          edits: {
            type: 'array',
            description: 'All replacements for this file, in order. Preferred over top-level oldString/newString whenever a file needs more than one change.',
            items: {
              type: 'object',
              properties: {
                oldString: { type: 'string', description: 'Exact existing text to replace, copied verbatim from the file.' },
                newString: { type: 'string', description: 'The replacement text.' },
                replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match. Defaults to false.' },
              },
              required: ['oldString', 'newString'],
            },
          },
          oldString: { type: 'string', description: 'Single-change form: exact existing text to replace, copied verbatim from the file.' },
          newString: { type: 'string', description: 'Single-change form: the replacement text.' },
          replaceAll: { type: 'boolean', description: 'Single-change form: replace every occurrence instead of requiring a unique match. Defaults to false.' },
        },
        required: ['path'],
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
// Which harness this run gets — structural gates only, or those plus the
// phrase gates a 14B-class model needs. See resolveHarnessProfile.
const HARNESS_PROFILE = resolveHarnessProfile({ isLocalProvider, modelId, override: harnessProfile });

// The tool list this run actually sends. Scoped once from what the host says is
// connected; every tool turn and the explore sub-agent draw from this, never
// from TOOL_DEFS directly.
const SCOPED_TOOL_DEFS = scopeToolDefs(TOOL_DEFS as Array<{ function: { name: string } }>, toolAvailability);
const PHRASE_GATES = phraseGatesEnabled(HARNESS_PROFILE);
// 20 for local (was 10): edit-heavy tasks need recovery headroom — a weak
// model spends turns redundantly (5 get_diagnostics + 3 test runs observed in
// one 4-edit rename) yet productively, and agent-evals s2 runs kept ending AT
// the cap with the rename nearly complete and the final forced answer merely
// announcing the remaining edit. The tool-output char budget (below) still
// bounds context growth independently, and the harness/UI wall-clock stays
// well inside its timeout at this depth.
//
// ── The budget is NOT rationed by what the message looks like ──
// It used to be: a run whose prompt matched IMPLEMENT_MANDATE_RE got +8 turns
// and double the char budget, everything else got the smaller tier. That
// regex matches "implement the fix" and "fix the bug" but NOT "can you fix
// it", "fix it", "fix this" or "please fix the rejection bug" — i.e. not how
// anyone actually asks — so real fix requests were silently handed half the
// resources and died at the cap mid-investigation (ADO #1534774, observed
// live 2026-09-05 across four mapper files with an untouched tree).
//
// Guessing better is not the fix; guessing at all was. A CEILING THAT IS NOT
// REACHED COSTS NOTHING: a question that needs three turns still ends after
// three, because the loop exits the moment the model stops calling tools.
// Only runs that genuinely keep working ever see this number, and those are
// exactly the runs that should have it. So there is one budget for every
// agent run, set at what the investigate-then-edit tier used to get, and the
// prompt text no longer influences it at all. Convergence is enforced
// structurally instead — see writePressure.ts, which withdraws the discovery
// tools at 70% of the budget whatever the run turned out to be.
//
// ── There is no turn cap ──
// This number is a runaway guard, not a budget: nothing in a healthy run is
// expected to approach it. What actually bounds a run is the context window
// (contextBudget.ts) — and crossing that is a reason to COMPACT AND CONTINUE,
// not to stop — plus stagnation, the wall clock, and the user's Stop button.
const SAFETY_ITERATION_CEILING = 200;
// Wall clock. Not a budget either — a run doing useful work is watched by a
// human who can stop it, and remote runs are metered in credits. This exists
// so a wedged run cannot occupy a worker forever.
const RUN_WALL_CLOCK_MS = 30 * 60 * 1000;
// Kept only for the arithmetic that still reads a nominal cap (the commit
// nudge's "turns left" wording and the run diagnostics line).
const MAX_TOOL_ITERATIONS = SAFETY_ITERATION_CEILING;
// Kept for the two places that legitimately want "this run has a ticket and
// changed nothing": the harness note and the self-diagnosing stamp. It no
// longer decides what the run is ALLOWED to spend.
// A ticket attached is not, by itself, a mandate to change the tree. On a
// research work item (Spike/Research/POC) the deliverable is the answer, so a
// zero-write run is a finished run — unless the user's own instruction for
// this run asks for the implementation too (#1536998 asked for both).
const TICKET_RESEARCH_RUN = !!ticketContext && isResearchWorkItem(ticketContext.type);
const TICKET_IMPLEMENT_MANDATE = !!executeMandate || IMPLEMENT_MANDATE_RE.test(prompt) || hasWriteIntent(prompt);
const TICKET_IMPLEMENT_RUN = !!ticketContext && (!TICKET_RESEARCH_RUN || TICKET_IMPLEMENT_MANDATE);
// Is CHANGING the workspace this turn's job? Now only feeds the commit NUDGE
// (prose the model may ignore) and the exploration-phase skip — positions
// where a miss costs a reminder or a little context, never a capability or a
// budget. Every gate where a miss used to cost something real has been moved
// off it; see writePressure.ts and isUnfinishedWriteRun.
const WRITE_INTENT_RUN =
  !!executeMandate || hasWriteIntent(prompt) || (!!ticketContext && IMPLEMENT_MANDATE_RE.test(prompt));

const isOpenRouter = (provider ?? '').toLowerCase() === 'openrouter';

// ── Provider prompt caching ──
//
// An agent turn resends the whole conversation on every round, so the prompt
// is re-billed 25+ times per run and the first message alone (rules + tool
// schemas + orientation + ticket) is tens of KB. Every provider worth using
// caches a repeated prefix; what differs is what they need from us.
//
//   · OpenAI, DeepSeek, Z.AI (GLM), Grok, Groq, Moonshot, Gemini 2.5 — cache
//     automatically off the token prefix. Nothing to send. This includes the
//     managed remote model, so no `cache_control` plumbing is needed for the
//     provider this project actually targets.
//   · Anthropic — needs a breakpoint (see CACHE_CONTROL below).
//   · Qwen — same explicit syntax as Anthropic, per-block only.
//
// The one thing that must be sent for ALL of them on OpenRouter is
// `session_id`. OpenRouter load-balances a model across several upstream
// providers and derives its sticky-routing key by hashing the messages — but
// a tool loop's messages CHANGE every round, so the derived key drifts and a
// later round can land on an upstream whose cache is cold. `session_id`
// (≤256 chars) replaces that hash with a key that is stable for the whole
// conversation, which is what pins every round of the run to the upstream
// holding the warm prefix. `prompt_cache_key` is OpenRouter's documented
// fallback for the same purpose and OpenAI's own cache-affinity knob, so it
// rides along; both are gated per provider because strict OpenAI-compatible
// endpoints reject unknown body fields.
const isRemoteManaged = provider === REMOTE_MODEL.PROVIDER;
const isOpenAIDirect = (provider ?? '').toLowerCase() === 'openai';
/**
 * Cache key for this run: the chat session, so it is identical across every
 * round of the loop AND across follow-up turns in the same conversation.
 * Absent on an older host — the fields are then simply not sent, which is the
 * behaviour that shipped before this existed.
 */
const CACHE_KEY = sessionId ? `wgpt-${sessionId}`.slice(0, 256) : undefined;
const PROMPT_CACHE_FIELDS: Record<string, unknown> = !CACHE_KEY
  ? {}
  : isOpenRouter || isRemoteManaged
    ? { session_id: CACHE_KEY, prompt_cache_key: CACHE_KEY }
    : isOpenAIDirect
      ? { prompt_cache_key: CACHE_KEY }
      : {};

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

const KNOWN_TOOL_NAMES = new Set(
  TOOL_DEFS.map((d: any) => d.function?.name).filter(Boolean)
);

/** One `run_checks` process, and every pending check it discharges. */
interface CheckJob {
  args: { path: string; kind: CheckKindName; paths?: string[] };
  covers: PendingCheck[];
}

/**
 * Turn a round's pending checks into the processes that will actually run.
 *
 * Every lint in the batch collapses into ONE call: type-aware eslint rebuilds
 * a TypeScript program on each process start (measured at 19.4s median and
 * 90.7s worst on a single file), so linting four changed files as four
 * invocations pays that cost four times for the same program. run_checks
 * drops any path that is not in the first one's package, so a batch spanning
 * two packages still lints the second one — on the next round, one process
 * each, which is what a per-package command has to cost anyway.
 *
 * Typecheck and test are left one call per file: their derived commands are
 * already package-wide, and the host replays an identical one for free.
 */
function planCheckJobs(batch: PendingCheck[]): CheckJob[] {
  const lints = batch.filter((c) => c.kind === 'lint');
  const jobs: CheckJob[] = [];
  if (lints.length > 0) {
    jobs.push({
      args: {
        path: lints[0].path,
        kind: 'lint',
        ...(lints.length > 1 ? { paths: lints.slice(1).map((c) => c.path) } : {}),
      },
      covers: lints,
    });
  }
  for (const c of batch) {
    if (c.kind !== 'lint') jobs.push({ args: { path: c.path, kind: c.kind }, covers: [c] });
  }
  return jobs;
}

/**
 * Calls that must not overlap ANYTHING: they change the workspace (or, for
 * run_command, may), so a read beside them sees an indeterminate tree and a
 * check beside them verifies stale code. They act as barriers in the round —
 * everything keeps its original relative order across one.
 *
 * `run_checks` was in this set (as MUTATING_TOOL_NAMES) and is deliberately
 * out of it now: it only reads. It must not race a write, which the barrier
 * ordering still guarantees, but two checks may overlap each other — which is
 * the common shape (lint three changed files) and, measured on this
 * workspace, ~20s each of pure waiting.
 */
const BARRIER_TOOL_NAMES = new Set(['edit_file', 'create_file', 'delete_file', 'run_command']);

/** File-mutating subset whose success must be verified by diagnostics before the run may end. */
const FILE_WRITE_TOOL_NAMES = new Set(['edit_file', 'create_file', 'delete_file']);

// The autonomous prompt block says "NO ONE IS WATCHING", but the write tools'
// descriptions say "the user reviews and approves each edit" — a direct
// contradiction, and the sixth observed ticket-1324128 stall read exactly like
// a model resolving it in favor of deferring ("Applying the edit would require
// the file write tool, which I have not invoked — say the word"). In
// autonomous runs, rewrite that sentence so the tool contract matches the run
// contract.
if (autonomous) {
  for (const d of TOOL_DEFS as any[]) {
    const f = d?.function;
    if (!f || !FILE_WRITE_TOOL_NAMES.has(f.name) || typeof f.description !== 'string') continue;
    f.description = f.description.replace(
      /The user reviews and approves (each edit before it is applied; a rejection comes back as an error with their feedback|the creation before it happens|the deletion before it happens)\./,
      'This is an AUTONOMOUS run: the change is applied immediately (checkpointed and auditable) — no human review happens first, so never wait for or ask about approval.'
    );
  }
}

/**
 * GMI Cloud's MiniMax-M3 endpoint doesn't convert the model's tool-call
 * markup into a structured `tool_calls` response — it leaks the raw
 * `<invoke name="...">` XML into content, interleaved with a mangled
 * special-token marker ("]<]minimax[>[") that should have been stripped
 * server-side. Observed shape:
 *   ]<]minimax[>[<tool_call> ]<]minimax[>[<invoke name="read_file">]<]minimax[>[<path>foo.ts]<]minimax[>[</path>]<]minimax[>[</invoke> ]<]minimax[>[</tool_call>
 * Stripping the marker recovers plain <invoke>/<parameter> (or bare child-tag)
 * XML, which this parses into the same BufferedToolCall shape as the rest of
 * extractTextToolCalls's salvage paths.
 */
const MINIMAX_TOKEN_MARKER_RE = /\]<\]minimax\[>\[?/g;

function parseInvokeParams(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  const namedParamRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
  let found = false;
  let p: RegExpExecArray | null;
  while ((p = namedParamRe.exec(body))) {
    found = true;
    params[p[1]] = p[2].trim();
  }
  if (found) return params;
  // Fall back to bare child tags, e.g. <path>foo.ts</path>.
  const genericTagRe = /<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g;
  while ((p = genericTagRe.exec(body))) {
    params[p[1]] = p[2].trim();
  }
  return params;
}

function extractMinimaxInvokeToolCalls(content: string): BufferedToolCall[] {
  if (!content.includes('<invoke')) return [];
  const cleaned = content.replace(MINIMAX_TOKEN_MARKER_RE, '');
  const calls: BufferedToolCall[] = [];
  const invokeRe = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(cleaned))) {
    const name = m[1];
    if (!KNOWN_TOOL_NAMES.has(name)) continue;
    calls.push({
      id: `textcall_${Date.now()}_${calls.length}`,
      name,
      args: JSON.stringify(parseInvokeParams(m[2])),
    });
  }
  return calls;
}

/**
 * Salvages tool calls that a model emitted as plain text instead of the
 * structured tool_calls field. Smaller local models (qwen2.5-coder via
 * Ollama especially) frequently "narrate" a call as a JSON blob — bare,
 * inside a ```json fence, or wrapped in Qwen's <tool_call> tags — in which
 * case the loop would otherwise treat the turn as a final answer and stop
 * mid-exploration. Also covers GMI Cloud/MiniMax-M3's malformed <invoke> XML
 * (see extractMinimaxInvokeToolCalls).
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
  if (calls.length) return calls;
  return extractMinimaxInvokeToolCalls(content);
}

/**
 * Removes leaked model-formatted tool-call syntax from text meant to be shown
 * to the user as plain prose — the MiniMax marker debris plus any intact
 * <tool_call>/<invoke> wrapper tags. Used on turns where a call can't be
 * executed anyway (tools disabled for this turn) so cleanup, not execution,
 * is the only option.
 */
function stripLeakedToolCallSyntax(content: string): string {
  return content
    .replace(MINIMAX_TOKEN_MARKER_RE, '')
    .replace(/<invoke\s+name="[^"]*">[\s\S]*?<\/invoke>/g, '')
    .replace(/<\/?tool_call>/g, '')
    .trim();
}

/** True when `content` is (partly) model-formatted tool-call syntax rather than a plain-prose answer. */
function hasLeakedToolCallSyntax(content: string): boolean {
  if (!content) return false;
  if (extractTextToolCalls(content).length > 0) return true;
  return content.includes(']<]minimax[>') || content.includes('<invoke ');
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
        toolAvailability,
        // Drops the weak-model scaffolding from every turn of a strong-model
        // run, paired with the phrase gates PHRASE_GATES disables.
        harnessProfile: HARNESS_PROFILE,
        repoOrientation,
        workspaceRules,
        textAttachments,
        imageAttachmentNames: imageAttachments?.map((img) => img.name),
        mentionedFiles,
        executeMandate,
        ticketContext,
        implementMandate: TICKET_IMPLEMENT_MANDATE,
        autonomous,
        planMode,
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
      message: describeLlmFailure(error, provider),
      sessionInvalid:
        provider === REMOTE_MODEL.PROVIDER &&
        (error?.status ?? error?.statusCode ?? error?.response?.status) === 401,
    });
  }
}

/**
 * The SDK's raw message ("401 Your WorkspaceGPT session is not valid…") is
 * fine for real providers but useless as an instruction when the failing
 * endpoint is our own managed one: the user has no key to check, only a
 * session to renew. Rewrite the account-level statuses into the action they
 * imply, and leave every other error (and every local-mode provider) alone.
 */
function describeLlmFailure(error: any, provider?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (provider !== REMOTE_MODEL.PROVIDER) return raw;

  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  if (status === 401) {
    return 'Your WorkspaceGPT session has expired. Sign in again under Settings → Account.';
  }
  if (status === 403) {
    return 'This WorkspaceGPT account is not active. Check Settings → Account.';
  }
  if (status === 429) {
    // The Worker's own message already names the limit and the reset time.
    return error?.error?.message || error?.message || 'WorkspaceGPT request limit reached.';
  }
  return raw;
}

interface BufferedToolCall {
  id: string;
  name: string;
  args: string;
}

// The streamed-turn consumer lives in ./streamOutcome so the headless suite can
// drive it with a fake stream — see that file for why it needed a test.

/** Surfaces a key-rotation event to the main thread so it can show it in the UI instead of leaving it silent in the extension host console. */
function notifyKeyFailover(message: string): void {
  parentPort?.postMessage({ type: 'key_failover', message });
}

async function generateWithOpenAIStream(
  prompt: string,
  model: string,
  baseURL: string,
  apiKeys: string[],
  maxTokens = 4096,
  /** False on the retry below, so a model that only ever thinks cannot loop. */
  allowLengthRetry = true,
): Promise<void> {
  let userContent = buildUserContent(prompt);
  const call = (apiKey: string) => {
    const openai = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: getProviderDefaultHeaders(baseURL, apiKey),
    });
    return openai.chat.completions.create({
      model: model,
      messages: [
        {
          role: 'user',
          content: userContent,
        }
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
      stream: true,
      // Shares the run's cache key: a RAG/answer turn on the same session
      // reuses whatever prefix the agent rounds already warmed. Cast because
      // the extra keys otherwise stop the literal from selecting the SDK's
      // streaming overload, which is what types `stream` below as async.
      ...PROMPT_CACHE_FIELDS,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);
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

  const outcome = await consumeStream(stream, (content) =>
    parentPort?.postMessage({ type: 'chunk', content })
  );

  // A reasoning model can spend its whole budget thinking and emit no visible
  // content: the text arrives as `reasoning_content` deltas, and this path
  // forwards only `delta.content`. Measured against glm-5.3-flash on 2026-09-05
  // — 199 of 200 deltas were reasoning and `content` totalled ZERO characters,
  // so the turn was delivered as an empty answer with no error and no retry.
  //
  // runToolTurn already cures exactly this for the agent path (see its own
  // allowLengthRetry); the streamed path used by Confluence/ADO turns had no
  // equivalent, which is why a doc turn could silently produce nothing.
  if (allowLengthRetry && shouldRetryEmptyStream(outcome)) {
    console.warn(
      '[workspaceGPT] streamed turn produced no visible content ' +
        `(finish=${outcome.finishReason}, ${outcome.reasoningChars} reasoning chars) — ` +
        'retrying once with a larger token budget.'
    );
    // The recursive call posts its own 'done'; returning here keeps this turn
    // to exactly one terminal message.
    await generateWithOpenAIStream(prompt, model, baseURL, apiKeys, Math.max(maxTokens * 2, 16384), false);
    return;
  }

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
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const handler = (msg: any) => {
      if (msg?.type === 'tool_response' && msg.id === id) {
        parentPort?.off('message', handler);
        noteToolMs(name, Date.now() - started);
        msg.error ? reject(new Error(msg.error)) : resolve(msg.result);
      }
    };
    parentPort?.on('message', handler);
    parentPort?.postMessage({ type: 'tool_request', id, name, arguments: args });
  });
}

/**
 * Host-side wall clock per tool, so a finished run can say where its time
 * actually went. Until this existed the only way to answer "why did that take
 * twenty minutes" was to diff timestamps in the audit log by hand — and the
 * answer, when finally measured, was that verification subprocesses were ~60%
 * of the run. Anything optimised here should be visible here.
 *
 * Overlapping calls each bill their own elapsed time, so the total can exceed
 * the run's wall clock — that gap IS the parallelism, and it is the number
 * that says whether batching a round helped.
 */
const toolMsByName = new Map<string, { ms: number; calls: number }>();
let toolMsTotal = 0;
function noteToolMs(name: string, ms: number): void {
  const prev = toolMsByName.get(name) ?? { ms: 0, calls: 0 };
  toolMsByName.set(name, { ms: prev.ms + ms, calls: prev.calls + 1 });
  toolMsTotal += ms;
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

/**
 * Log the structure of the conversation that just failed.
 *
 * A malformed tool-call envelope is the most common cause of an opaque 4xx,
 * and the provider's status line names none of it — so report the structural
 * defect (and the shape, always) rather than leaving only "400".
 */
function reportEnvelope(messages: any[]): void {
  const violations = findEnvelopeViolations(messages);
  if (violations.length) {
    console.error('[workspaceGPT] malformed tool-call conversation:', violations);
  }
  console.error('[workspaceGPT] message envelope at failure:', describeEnvelope(messages));
}

/**
 * Explicit cache breakpoints, for the model families that require them.
 *
 * Anthropic is NOT handled here — see CACHE_CONTROL below. Marking the first
 * and last message by hand (what this used to do for Anthropic) silently
 * failed for the case that matters: on an agent round the last message is
 * almost always a `tool` result, which this function skips, so only the
 * breakpoint at message 0 was ever placed and the growing transcript above it
 * was re-billed in full on every round.
 *
 * Qwen takes Anthropic's per-block syntax and has no top-level form, so it
 * keeps the manual treatment: a breakpoint on the stable first message (the
 * structured prompt — rules, orientation, ticket) and one on the newest
 * cacheable message, which extends the cached prefix as the conversation
 * grows. Messages are shallow-copied — the loop's own array is the transcript
 * and must stay plain.
 */
/**
 * What a model family needs from us in order to cache a repeated prefix,
 * keyed on the VENDOR half of the OpenRouter model id
 * (`anthropic/claude-sonnet-4.5` → `anthropic`).
 *
 * That prefix is structured data in a machine-generated id, so reading it is
 * parsing — not a substring hunt across the whole slug, which is how `/qwen/i`
 * and `/claude|anthropic/i` used to decide this at two separate call sites.
 * An unknown vendor falls through to 'automatic', i.e. send nothing: a family
 * we do not recognise loses a cache hint (costs money) and never has a request
 * rejected (costs the run). Adding a family is one line in the table.
 */
type CacheStyle =
  /** Caches off the token prefix unaided — nothing to send. OpenAI, DeepSeek, Z.AI (GLM), Grok, Groq, Moonshot, Gemini 2.5, and the managed remote model. */
  | 'automatic'
  /** One top-level `cache_control`, so OpenRouter moves the breakpoints with the conversation. */
  | 'top-level-breakpoint'
  /** Per-block `cache_control` with no top-level form, so the blocks are marked by hand. */
  | 'per-block-breakpoint';

const CACHE_STYLE_BY_VENDOR: Record<string, CacheStyle> = {
  anthropic: 'top-level-breakpoint',
  qwen: 'per-block-breakpoint',
};

/** The vendor half of an OpenRouter model id, lowercased — the whole id if it carries no prefix. */
function modelVendor(model: string): string {
  return String(model ?? '').split('/')[0].trim().toLowerCase();
}

/**
 * Only OpenRouter accepts these fields: a strict OpenAI-compatible endpoint
 * 400s on an unknown body key, so every other provider is 'automatic' here
 * regardless of which model it is serving.
 */
function cacheStyleFor(model: string): CacheStyle {
  if (!isOpenRouter) return 'automatic';
  return CACHE_STYLE_BY_VENDOR[modelVendor(model)] ?? 'automatic';
}

function withPromptCache(messages: any[], model: string): any[] {
  if (cacheStyleFor(model) !== 'per-block-breakpoint' || messages.length === 0) return messages;
  const mark = (msg: any) => {
    if (!msg || (msg.role !== 'user' && msg.role !== 'system')) return msg;
    if (typeof msg.content === 'string') {
      return { ...msg, content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }] };
    }
    if (Array.isArray(msg.content) && msg.content.length) {
      const parts = msg.content.slice();
      const lastText = [...parts].reverse().findIndex((p: any) => p?.type === 'text');
      if (lastText >= 0) {
        const idx = parts.length - 1 - lastText;
        parts[idx] = { ...parts[idx], cache_control: { type: 'ephemeral' } };
      }
      return { ...msg, content: parts };
    }
    return msg;
  };
  const out = messages.slice();
  out[0] = mark(out[0]);
  const lastIdx = out.length - 1;
  if (lastIdx > 0) out[lastIdx] = mark(out[lastIdx]);
  return out;
}

/**
 * Anthropic caching on OpenRouter, done the automatic way: a top-level
 * `cache_control` tells OpenRouter to cache everything up to the last
 * cacheable block, so the breakpoints move with the conversation instead of
 * being pinned to two messages we picked in advance. That is exactly the
 * shape of a tool loop — an append-only transcript whose tail is a tool
 * result — and it is why the per-block marking above no longer covers
 * Anthropic. Deliberately not combined with per-block breakpoints: they are
 * documented as alternatives.
 *
 * Every other family either caches automatically (OpenAI, DeepSeek, Z.AI/GLM,
 * Grok, Groq, Moonshot, Gemini 2.5 implicit) or ignores the field; the gate
 * keeps it away from strict endpoints that would 400 on an unknown key.
 */
function cacheControlField(model: string): Record<string, unknown> {
  return cacheStyleFor(model) === 'top-level-breakpoint' ? { cache_control: { type: 'ephemeral' } } : {};
}

async function runToolTurn(
  messages: any[],
  model: string,
  baseURL: string,
  apiKeys: string[],
  withTools: boolean,
  maxTokens: number = 8192,
  allowLengthRetry: boolean = true,
  /** Tool defs for this turn. Defaults to the full set; the `explore`
   *  sub-agent passes a read-only subset. */
  tools: unknown[] = TOOL_DEFS
): Promise<ToolTurnOutcome> {
  const call = (apiKey: string) => {
    // maxRetries above the SDK's default of 2 (0.5s then 1s of backoff, sized
    // for a network blip). A tool turn is the most expensive thing to lose:
    // failing one discards the whole run's message array, so the extra two
    // attempts are cheap insurance. Sustained outages are handled a layer up,
    // in withKeyFailover's TRANSIENT_RETRY_DELAYS_MS schedule; this only
    // absorbs the short blips so that schedule is rarely reached.
    const openai = new OpenAI({
      apiKey,
      baseURL,
      maxRetries: MODEL_CLIENT_MAX_RETRIES,
      defaultHeaders: getProviderDefaultHeaders(baseURL, apiKey),
    });
    return openai.chat.completions.create({
      model,
      messages: withPromptCache(messages, model),
      ...(withTools ? { tools: tools as any, tool_choice: 'auto' as const } : {}),
      // Prompt caching: the routing/affinity key for every round of this run,
      // plus the breakpoint field for families that need one.
      ...(PROMPT_CACHE_FIELDS as any),
      ...(cacheControlField(model) as any),
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
      console.error(
        `[workspaceGPT] ${(err as any)?.status ?? 'request'} rejected with images attached — retrying without them.`
      );
      parentPort?.postMessage({
        type: 'image_unsupported',
        message: `${model} couldn't process the attached image(s) — continuing without them.`,
      });
      try {
        response = await withKeyFailover(apiKeys, call, notifyKeyFailover);
      } catch (retryErr) {
        // The images were not the cause after all; the envelope is now the
        // best evidence there is, so it must be logged on this path too.
        reportEnvelope(messages);
        throw retryErr;
      }
    } else {
      reportEnvelope(messages);
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
//
// ── DERIVED from the context window, not set beside it ──
// This used to be a flat 400,000 characters. At ~4 chars/token that is about
// 100k tokens — half of the 200k window the run is supposed to be bounded by —
// so it, not the context, was what actually ended long runs, and truncation of
// old results began at ~70k tokens while the context meter still read 35%.
// The run was quietly forgetting evidence and telling the user it had
// two-thirds of its notebook left. Exactly the turn-cap mistake one level
// down: a proxy for the real limit, set independently, biting first.
//
// Now it is a fraction of the same window the meter shows, so it lands just
// BELOW the context bound and acts as a backstop for the case where a provider
// reports no usage at all — never as the thing that governs.
const MANAGED_CONTEXT_TOKENS = resolveContextWindow({ modelId, override: contextWindowOverride });
/** Rough bytes-per-token for OpenAI-family tokenizers on source code. */
const CHARS_PER_TOKEN = 4;
/**
 * Share of the window tool output may occupy. The rest is the system prompt,
 * chat history, @-mentions and the model's own turns, which are not counted
 * here but do consume the same window.
 */
const TOOL_OUTPUT_WINDOW_SHARE = 0.9;
const MAX_TOTAL_TOOL_CHARS = Math.round(
  MANAGED_CONTEXT_TOKENS * CHARS_PER_TOKEN * TOOL_OUTPUT_WINDOW_SHARE
);
// A read_file result is a deliberate, targeted fetch of one known file, so it
// earns a larger cap than a survey does: truncating it at the search budget
// is what turned single files into two-call reads (and then re-reads) on
// ticket #1534774. Searches keep the tighter cap — a wide grep is exactly the
// thing that should be narrowed rather than enlarged.
//
// Expressed as a FRACTION of the run's total budget, not a flat number. The
// first version of this was a flat 72k, which measured out at 18% of a ticket
// run's whole 400k tool-output budget in a single call — five or six reads of
// large files and the run was out of tools. A per-call cap has to be
// proportionate to the pot it draws from, and it must never sit below a
// search result's cap.
const MAX_READ_RESULT_CHARS = Math.max(
  MAX_TOOL_RESULT_CHARS,
  Math.min(48_000, Math.floor(MAX_TOTAL_TOOL_CHARS * 0.12))
);

/** One message of a resumed transcript, as the host streamed it up from the previous run. */
type ResumeMessage = Record<string, any>;

/**
 * Everything a resumed transcript tells us about the run that produced it.
 *
 * The counters matter as much as the messages: the loop's honesty gates are
 * counter-driven (`writesApplied === 0` + an answer that mentions changes →
 * "you claim changes were made but nothing was applied"), so a resumed run
 * starting them at zero would fire those gates against work the previous
 * segment genuinely did — and, worse, tell the model its real edits were
 * imaginary.
 */
interface ResumeState {
  messages: ResumeMessage[];
  /** Files whose current content the model has already seen — arms the read-before-edit guard correctly. */
  readPaths: Set<string>;
  writesApplied: number;
  writesSinceDiagnostics: number;
  anyWriteAttempted: boolean;
  lastWriteOutcome: Map<string, boolean>;
  /** Files written (not deleted) in the interrupted run, oldest first. */
  writtenPaths: Set<string>;
  /** `${path}::${kind}` checks the interrupted run already ran against the current content. */
  checksDone: Set<string>;
  okToolResults: number;
  toolCallsExecuted: number;
  /** Sum of the resumed tool results' serialized lengths — seeds the output budget. */
  toolChars: number;
  /**
   * Index/name/size of every resumed tool message, so microcompaction can
   * rewrite them, plus the 0-based index of the resumed round it came from
   * (the loop stamps them as `roundIndex - rounds`, so they sit behind round 0).
   */
  toolResults: { msgIndex: number; name: string; chars: number; roundIndex: number }[];
  /** How many tool rounds the resumed transcript contains. */
  rounds: number;
  /**
   * The harness limit that ended the previous segment, if one did. Its
   * announcement is stripped from the resumed messages (see resumeHygiene.ts);
   * the continuation prompt tells the model the budget is fresh instead.
   */
  endedAtLimit: LimitKind | null;
}

/** Filler for a declared tool call whose result never arrived — invalid to omit, but not a real result. */
const INTERRUPTED_TOOL_RESULT = '[interrupted — this tool never ran, its result is unknown]';

/** True when a tool message's serialized content represents a failed call. */
function toolResultFailed(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  try {
    return !!(JSON.parse(content) as { error?: unknown } | null)?.error;
  } catch {
    // Truncated (i.e. large, i.e. successful) or non-JSON — not an error object.
    return false;
  }
}

/**
 * Rebuilds a resumable conversation from the messages a previous run streamed
 * up, and derives the loop state that went with them.
 *
 * Repairs the transcript on the way through, because a run that died mid-round
 * can leave an assistant `tool_calls` turn whose results never arrived — and
 * several OpenAI-compat backends reject the whole request when a declared tool
 * call has no matching `role: 'tool'` reply (or when a stray reply matches no
 * call). Missing replies become explicit "never ran" markers rather than being
 * dropped along with their call.
 *
 * Returns null when there is nothing usable to resume from.
 */
function seedFromTranscript(raw: unknown): ResumeState | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const present = raw.filter((m): m is ResumeMessage => !!m && typeof m === 'object' && 'role' in m);
  // The previous segment's "step limit reached / no further tools / answer
  // now" messages describe a budget THIS segment does not have. Left in, the
  // model reads them as current and ends the resumed run after one call
  // (observed on #1534774 — see resumeHygiene.ts).
  const pruned = pruneStaleHarnessMessages(present);
  const entries = pruned.messages;
  if (!entries.length) return null;

  const messages: ResumeMessage[] = [];
  const state: ResumeState = {
    messages,
    readPaths: new Set<string>(),
    writesApplied: 0,
    writesSinceDiagnostics: 0,
    anyWriteAttempted: false,
    lastWriteOutcome: new Map<string, boolean>(),
    writtenPaths: new Set<string>(),
    checksDone: new Set<string>(),
    okToolResults: 0,
    toolCallsExecuted: 0,
    toolChars: 0,
    toolResults: [],
    rounds: 0,
    endedAtLimit: pruned.endedAtLimit,
  };

  for (let i = 0; i < entries.length; i++) {
    const msg = entries[i];
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : null;
    if (msg.role !== 'assistant' || !calls?.length) {
      messages.push(msg);
      continue;
    }

    // Collect the contiguous run of tool replies that belongs to this turn, so
    // they can be re-emitted in tool_calls order with the gaps filled in.
    const replies = new Map<string, ResumeMessage>();
    let j = i + 1;
    for (; j < entries.length && entries[j].role === 'tool'; j++) {
      replies.set(String(entries[j].tool_call_id ?? ''), entries[j]);
    }
    i = j - 1;

    messages.push(msg);
    const roundIndex = state.rounds++;
    for (const call of calls) {
      const id = String(call?.id ?? '');
      const name = String(call?.function?.name ?? '');
      const reply =
        replies.get(id) ??
        ({
          role: 'tool',
          tool_call_id: id,
          content: INTERRUPTED_TOOL_RESULT,
        } as ResumeMessage);
      const missing = !replies.has(id) || reply.content === INTERRUPTED_TOOL_RESULT;
      messages.push(reply);

      const chars = typeof reply.content === 'string' ? reply.content.length : 0;
      state.toolChars += chars;
      state.toolResults.push({ msgIndex: messages.length - 1, name, chars, roundIndex });
      if (missing) continue;

      state.toolCallsExecuted++;
      const failed = toolResultFailed(reply.content);
      if (!failed) state.okToolResults++;

      let args: { path?: unknown; kind?: unknown } = {};
      try {
        args = call?.function?.arguments ? JSON.parse(String(call.function.arguments)) : {};
      } catch {
        /* unparseable args — nothing to derive from them */
      }
      const path = typeof args.path === 'string' ? args.path.replace(/^\.?\//, '') : '';

      if (!failed && (name === 'read_file' || name === 'create_file') && path) state.readPaths.add(path);
      if (FILE_WRITE_TOOL_NAMES.has(name)) {
        state.anyWriteAttempted = true;
        if (path) state.lastWriteOutcome.set(path, !failed);
        if (!failed) {
          state.writesApplied++;
          state.writesSinceDiagnostics++;
          if (path) {
            state.writtenPaths.delete(path);
            if (name !== 'delete_file') state.writtenPaths.add(path);
            for (const k of ['lint', 'typecheck', 'test']) state.checksDone.delete(`${path}::${k}`);
          }
        }
      }
      if (name === 'get_diagnostics' && !failed) state.writesSinceDiagnostics = 0;
      if (name === 'run_checks' && !failed && path) {
        state.checksDone.add(`${path}::${typeof args.kind === 'string' ? args.kind : 'test'}`);
      }
    }
  }

  // A trailing assistant turn with neither content nor tool calls is debris
  // from a round that never got anywhere; the new user turn reads better
  // straight after the last real exchange.
  while (messages.length) {
    const last = messages[messages.length - 1];
    if (last.role === 'assistant' && !last.tool_calls?.length && !String(last.content ?? '').trim()) {
      messages.pop();
      continue;
    }
    break;
  }

  return messages.length ? state : null;
}

async function runAgentLoop(initialPrompt: string, model: string, baseURL: string, apiKeys: string[]): Promise<void> {
  // A turn that follows an interrupted run continues that run's conversation:
  // the tool calls and results above are the work already done, and rebuilding
  // from scratch would re-derive all of it (and, with a bare "continue" as the
  // prompt, re-scout the workspace for the word "continue"). The lean
  // continuation turn is appended to it instead of a fresh structured prompt —
  // the rules, orientation and rules files are already in its first turn.
  const resume = seedFromTranscript(resumeTranscript);
  const messages: any[] = resume
    ? [
        ...resume.messages,
        {
          role: 'user',
          content: buildUserContent(
            createContinuationPrompt(prompt, {
              textAttachments,
              imageAttachmentNames: imageAttachments?.map((img) => img.name),
              mentionedFiles,
              executeMandate,
              toolResultsAbove: resume.toolCallsExecuted,
              previousSegmentEndedAt: resume.endedAtLimit,
            })
          ),
        },
      ]
    : [{ role: 'user', content: buildUserContent(initialPrompt) }];
  if (resume) {
    parentPort?.postMessage({
      type: 'resumed',
      steps: resume.toolCallsExecuted,
      writesApplied: resume.writesApplied,
    });
  }
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
  /**
   * Investigation calls (read_file + the discovery tools) made before the
   * first write. Feeds the third convergence trigger — see
   * INVESTIGATION_CALLS_WITHOUT_WRITE in writePressure.ts. Stops mattering the
   * moment a write lands, which is why it is never reset.
   */
  let investigationCallsWithoutWrite = 0;
  let planNudgesUsed = 0;
  // The last answer that was a finished, verified report (writes landed,
  // diagnostics clean after them, REPORT_SHAPED_RE). If the gates' follow-up
  // rounds then eat the remaining iterations, THIS is delivered at the cap —
  // not a forced "step limit reached" rewrite of a task that was done.
  let lastReportAnswer = '';
  // True once run_command succeeded after the most recent applied write —
  // the report's Verification section is then backed by an actual run, so
  // the write-oriented completeness reflection has nothing left to ask for.
  let commandRunSinceWrite = false;
  // ── Latency-adaptive degradation state (see SLOW_TURN_MS above) ──
  let turnMsTotal = 0;
  let slowModelMode = false;
  let iterationCap = MAX_TOOL_ITERATIONS;
  // ── Context accounting (contextBudget.ts) ──
  // `windowTokens` is the only assumption in the run, and it self-corrects
  // from prompts the provider actually accepted. Everything else here is the
  // provider's own `usage.prompt_tokens`.
  let windowTokens = resolveContextWindow({ modelId: model, override: contextWindowOverride });
  let contextNow = contextState({ promptTokens: 0, windowTokens });
  /** Consecutive turns that surfaced nothing new — the runaway-loop backstop. */
  let turnsWithoutProgress = 0;
  /**
   * Signatures of tool results already seen this run. A model looping on the
   * same search produces bytes on every turn but no information, so counting
   * characters (or tool calls) would score that loop as progress — which is
   * precisely the case the stagnation backstop exists to catch. Identity of
   * the RESULT is the honest signal.
   */
  const seenToolResults = new Set<string>();
  const noteToolResultSeen = (name: string, content: string): void => {
    seenToolResults.add(`${name}:${content.length}:${content.slice(0, 200)}`);
  };
  /** One-shot: the discovery tools have been withdrawn and the model told why. */
  let commitNarrowingApplied = false;
  /** One-shot: the cap has been extended once so a late write could be verified. */
  let verificationReserveUsed = false;
  const enterSlowMode = (observedMs: number, atIteration: number) => {
    if (slowModelMode) return;
    // An autonomous run has no one waiting on latency — degrading it only
    // starves the investigation. Observed live: a ticket run on a slow local
    // model hit the slow-mode cap at 13 tool calls with 9% of the tool budget
    // used, got its tools cut off mid-read, and delivered a "## Blocked"
    // blaming the harness. Autonomous runs keep their full iteration cap.
    if (autonomous) return;
    slowModelMode = true;
    // ── Slow mode no longer CUTS the iteration cap ──
    // It used to drop it to 8 turns (16 for a run whose prompt matched the
    // implement-mandate regex — the same broken guess that starved the
    // budget). Cutting turns because the model is slow does not save the
    // waiting human anything: they get no answer, ask again, and sit through
    // a second run. It converted latency into failure, and it did so hardest
    // on exactly the slow, monorepo-scale investigations that needed the
    // turns most. Convergence is now forced by writePressure.ts at 70% of the
    // budget, which does the job this cut was reaching for without depending
    // on any guess about the prompt. Slow mode still does the two things that
    // genuinely save time: it skips the optional polish reflections and
    // narrows the exploration phase, and it tells the user the run is slow.
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
  // Autonomous runs get bounded retries instead of one shot: see the error, fix
  // it, get re-checked — the loop a human reviewer would otherwise drive.
  const AUTO_DIAGNOSTICS_LIMIT = autonomous ? 3 : 1;
  let autoDiagnosticsRuns = 0;
  // ── Auto-verification: lint / typecheck / tests, not just diagnostics ──
  // Diagnostics are what the editor's language server happens to know; they
  // are not proof the change works (see autoVerify.ts). The loop therefore
  // runs the outstanding checks ITSELF before it will accept a final answer,
  // as synthetic run_checks calls — the same deterministic trick as the
  // auto-diagnostics pass below, batched into one round trip — and the model
  // then sees real failures in its transcript and fixes them, exactly as it
  // would its own output. run_checks needs no approval gate in either mode:
  // the host derives a test/lint/typecheck command for the file's own package,
  // so it is unattended-safe by construction.
  const autoVerify = new AutoVerifyTracker({
    // Enough for the checks on a few changed files PLUS a fix-and-re-verify
    // cycle. Autonomous runs get more: no one is waiting on them, and a
    // failure nobody sees is the whole thing they exist to prevent.
    limit: autonomous ? 18 : 12,
  });
  /** Round counter, only so synthetic tool_call ids stay unique. */
  let autoVerifyRounds = 0;
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
  // Delivery-time honesty stamp: when a turn NARRATES completed changes
  // ("## Implemented fix", "### Changes", "the block is removed") that no
  // write in this session backs up, append a harness correction to the answer
  // itself. The confrontation gates above are bounded and budget-guarded, so
  // a persistent (or budget-exhausted) model can still deliver the lie — this
  // line cannot be phrased around, because the model never sees it.
  //
  // Scope lives in isUnbackedCompletionClaim (answerGates): it fires on ANY
  // turn whose answer heads itself "Done" while claiming file changes, not
  // just the ticket/approved-plan runs it used to be limited to — a follow-up
  // question produced exactly that fabricated report unstamped. A truthful
  // recap of an earlier turn's real edits is protected by priorWrites, and a
  // plan-mode proposal by planMode.
  const finalizeDeliverable = (text: string): string => {
    // The FINAL REPORT FORMAT says "no preamble"; models still narrate one
    // sentence before the status heading. Removing it here keeps the banner
    // first in the panel and in saved history alike.
    let out = stripReportPreamble(text);
    if (
      out &&
      isUnbackedCompletionClaim(out, {
        writesApplied,
        priorWritesInSession: priorWrites,
        writeExpected: TICKET_IMPLEMENT_RUN || executeMandate || anyWriteAttempted,
        planMode,
      })
    ) {
      out +=
        '\n\n---\n⚠️ **Harness note:** zero file edits were actually applied in this run — the working tree is unchanged, so any "implemented fix" above is a proposal only. Reply "go ahead" to have it applied.';
    }
    // Self-diagnosing zero-write ticket runs: every failure so far had to be
    // diagnosed from answer prose because the [agent-metrics] console line
    // never made it into the bug report. Stamp the numbers that matter onto
    // the answer itself (plan mode excluded — zero writes is its contract).
    if (out && !!ticketContext && !planMode && writesApplied === 0) {
      const pct = Math.min(100, Math.round((toolCharsUsed / MAX_TOTAL_TOOL_CHARS) * 100));
      const nudgesFired = [
        planInsteadOfExecuteNudgeUsed ? 'plan' : '',
        incompleteAnswerNudgesUsed > 0 ? `incomplete×${incompleteAnswerNudgesUsed}` : '',
        prematureAmbiguityNudgeUsed ? 'ambiguity' : '',
        commitNudgeNarrationUsed || commitNudgeBudgetUsed
          ? `commit(${[commitNudgeNarrationUsed ? 'cause' : '', commitNudgeBudgetUsed ? 'budget' : ''].filter(Boolean).join('+')})`
          : '',
        ticketCompletionNudgeUsed ? 'ticket' : '',
        missingToolClaimNudgeUsed ? 'missingTool' : '',
        phantomChangesNudgesUsed > 0 ? `phantom×${phantomChangesNudgesUsed}` : '',
        forceReadUsed ? 'forceRead' : '',
        commitNarrowingApplied ? 'narrowed' : '',
      ].filter(Boolean);
      out +=
        `\n\n<sub>Run diagnostics: ${toolCallsExecuted} tool calls over ${perTurn.length} turns (cap ${iterationCap}${slowModelMode ? ', slow-model mode' : ''}) · ${HARNESS_PROFILE} harness · 0 edits applied` +
        `${anyWriteAttempted ? ' (writes attempted but none landed)' : ' (no write ever attempted)'}` +
        ` · tool budget ${pct}% used${budgetExhausted ? ' — EXHAUSTED, honesty gates skipped' : ''}` +
        ` · nudges fired: ${nudgesFired.length ? nudgesFired.join(', ') : 'none'}` +
        // The reason the loop ACTUALLY ended, next to the counters that
        // otherwise contradict it: #1384667's footer read "62 turns (cap 200)
        // · tool budget 49% used" under a heading that blamed the step limit.
        ` · stopped: ${stopReason === 'none' ? 'model concluded (no harness limit hit)' : HARNESS_LIMIT_PHRASE[stopReason]}</sub>`;
    }
    return out;
  };
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
  // Answer-shape failure signatures live in answerGates.ts (shared with the
  // eval harness, which pins the live transcripts that motivated each one).
  let planInsteadOfExecuteNudgeUsed = false;
  // One-shot: an answer that declares the task unclear while naming
  // investigation it could still do itself (see PREMATURE_AMBIGUITY_RE).
  let prematureAmbiguityNudgeUsed = false;
  // P2 commit nudge: fired once, when a write-intent run is deep into its
  // turns (or has just said out loud that it found the cause) with nothing
  // written. Every other gate in this file inspects the FINAL ANSWER, which
  // is too late — #1534774 never produced an in-loop answer at all, so not one
  // of them ran ("nudges fired: none" in its own diagnostics) while the run
  // read its way through the cap. This one watches PROGRESS instead, which is
  // why it generalises past the phrasing of any single failure.
  //
  // Two independent one-shots rather than a single flag: the narration
  // trigger can legitimately fire early (the model says it found the cause on
  // turn 8), and if a single flag were spent there, the deep-into-the-budget
  // backstop — the one that actually catches a run reading its way to the cap
  // — could never fire at all. Each fires at most once, so a run sees two
  // reminders maximum.
  // Delegated investigations this run. Capped because each one is a whole
  // sub-loop of API calls: the context saving is real but the wall-clock and
  // token cost is not free, and a model that delegates instead of deciding is
  // just stalling by proxy. Past the cap the tool reports that it is spent and
  // tells the model to read directly.
  // ── Sub-agent delegation is a strategy, not a rationed favour ──
  // Was 3. A delegated investigation burns ITS OWN context and returns a short
  // answer, so it is the cheapest way to keep the main conversation small —
  // the reason Claude Code leans on sub-agents instead of compacting. Capping
  // it at 3 made the cheap path run out first and pushed the run back to
  // reading everything into the main context. Now a high runaway guard, in the
  // same spirit as SAFETY_ITERATION_CEILING: sub-agent results land in this
  // conversation as ordinary tool results, so the context bound already prices
  // them honestly.
  const MAX_EXPLORE_CALLS = isLocalProvider ? 8 : 25;
  let exploreCallsUsed = 0;
  let commitNudgeNarrationUsed = false;
  let commitNudgeBudgetUsed = false;
  // One-shot: the harness force-reads the files a stall answer names as
  // unread instead of ending the run to ask for another turn.
  let forceReadUsed = false;
  // One-shot structural backstop for implement-mandated ticket runs: zero
  // writes + no terminal section ("## Blocked" / "## No change needed") is a
  // stall regardless of how the answer is phrased — see TICKET_TERMINAL_RE.
  let ticketCompletionNudgeUsed = false;
  // One-shot: the answer claimed a write tool is missing from its tool list —
  // always false (TOOL_DEFS is sent whole on every request), so confront with
  // that fact instead of letting a well-formed-but-false "## Blocked" stand.
  let missingToolClaimNudgeUsed = false;

  // Once the cumulative tool-output budget is gone, every further tool call
  // gets back nothing but the "[budget exhausted]" marker — the model can't
  // see any new data, yet without this flag it kept spending whole
  // iterations calling tools anyway (observed: 7 of 10 rounds wasted this way
  // on a large monorepo query). Once set, the round-robin loop below stops
  // accepting further tool calls and forces the final answer immediately.
  let budgetExhausted = false;
  /**
   * WHY the loop stopped, for the forced-answer message below.
   *
   * Every exit assigns before it breaks; the `for` condition running out is
   * promoted to 'steps' after the loop. Previously this was inferred from
   * `budgetExhausted` alone, so the wall clock and a full context window were
   * both announced as a step limit (#1384667: "step limit reached" at 62 turns
   * of a 200 cap, 49% budget).
   *
   * 'none' is the DEFAULT and the commonest ending: the model answered and the
   * loop returned from inside. It used to default to 'steps', which is only
   * ever correct for one of the five exits — so the footer on #1536998's
   * blocked run read "stopped: step limit reached" beside "41 tool calls over
   * 7 turns (cap 200) · tool budget 7% used", and the reader has to guess
   * which half is lying. A limit that did not fire must not be named.
   */
  let stopReason: LimitKind | 'none' = 'none';
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

  const serializeToolResult = (result: unknown, toolName?: string): string => {
    let s = JSON.stringify(result);
    const perResultCap = toolName === 'read_file' ? MAX_READ_RESULT_CHARS : MAX_TOOL_RESULT_CHARS;
    if (s.length > perResultCap) {
      s = s.slice(0, perResultCap) + '\n…[result truncated — narrow the query or read a specific line range]';
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
    noteToolResultSeen(name, content);
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



  // Adopt the interrupted run's state so this segment behaves like a
  // continuation of it rather than a fresh run that happens to have a long
  // history: the budget already spent stays spent, the honesty gates see the
  // writes that really landed, and the resumed tool results are registered with
  // microcompaction so they are the first candidates to collapse when this
  // segment's own results push against the budget.
  if (resume) {
    toolCharsUsed = resume.toolChars;
    toolCallsExecuted = resume.toolCallsExecuted;
    okToolResults = resume.okToolResults;
    writesApplied = resume.writesApplied;
    writesSinceDiagnostics = resume.writesSinceDiagnostics;
    anyWriteAttempted = resume.anyWriteAttempted;
    for (const [path, ok] of resume.lastWriteOutcome) lastWriteOutcome.set(path, ok);
    for (const path of resume.readPaths) readPaths.add(path);
    autoVerify.restore({ writtenPaths: [...resume.writtenPaths], checksDone: [...resume.checksDone] });
    // Resumed rounds are numbered backwards from this segment's round 0, so the
    // keep-recent window keeps meaning what it says across the seam: the last
    // resumed round stays intact for now, everything older is compactable, and
    // as this segment advances the resumed rounds age out in their original
    // order instead of all at once.
    for (const r of resume.toolResults) {
      toolResultLog.push({
        msgIndex: r.msgIndex,
        name: r.name,
        round: r.roundIndex - resume.rounds,
        chars: r.chars,
        compacted: false,
      });
    }
    // A transcript long enough to have died of a provider error is often already
    // over the pressure threshold on its own: collapse the old end of it now
    // rather than letting this segment's first tool call be what blows the
    // budget. No-ops below the threshold.
    compactOldToolResults(0);
  }

  // ── Resumable transcript (streamed up to the host) ──
  // `messages` is the only record of what this run has done, and it dies with
  // the worker — which is exactly what happens on a provider error, a crash, a
  // stall, or a user stop. Mirroring it to the host at every round boundary is
  // what makes the next turn able to resume instead of re-exploring. Sent
  // before each completion, so whatever the model was about to be asked is
  // already safe on the other side if that request is the thing that fails.
  //
  // Append-only, deliberately: microcompaction rewrites earlier messages in
  // place and those rewrites are NOT mirrored, so the host keeps the full-size
  // results. That is the right way round — a resumed run re-derives its own
  // pressure from real sizes and re-compacts, instead of inheriting a collapsed
  // history it can never get back.
  let transcriptSentUpTo = 0;
  let transcriptBaseSent = false;
  const syncTranscript = (): void => {
    if (transcriptBaseSent && messages.length === transcriptSentUpTo) return;
    const from = transcriptSentUpTo;
    transcriptSentUpTo = messages.length;
    if (!transcriptBaseSent) {
      // First sync carries the whole array: on a resumed run this is the
      // REPAIRED transcript (gaps filled, debris dropped), which must replace
      // the host's copy rather than be appended to it.
      transcriptBaseSent = true;
      parentPort?.postMessage({ type: 'agent_transcript', reset: messages.slice() });
      return;
    }
    parentPort?.postMessage({ type: 'agent_transcript', append: messages.slice(from) });
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
      /** Wall clock spent waiting on the model, summed over turns. */
      modelMs: turnMsTotal,
      /** Wall clock spent inside host tools; overlapping calls each bill their own. */
      toolMs: toolMsTotal,
      toolMsByName: Object.fromEntries([...toolMsByName].sort((a, b) => b[1].ms - a[1].ms)),
      failedToolCalls: [...failedCalls.values()].reduce((a, b) => a + b, 0),
      toolCharsUsed,
      budgetExhausted,
      compactions: toolResultLog.filter((e) => e.compacted).length,
      exploration: explorationStats,
      /** Tool results inherited from an interrupted run this turn resumed (0 = fresh run). */
      resumedToolResults: resume?.toolCallsExecuted ?? 0,
      nudges: {
        plan: planNudgesUsed,
        incompleteAnswer: incompleteAnswerNudgesUsed,
        failedWrites: failedWritesNudgeUsed ? 1 : 0,
        phantomChanges: phantomChangesNudgesUsed,
        summary: summaryNudgeUsed ? 1 : 0,
        prematureAmbiguity: prematureAmbiguityNudgeUsed ? 1 : 0,
        ticketCompletion: ticketCompletionNudgeUsed ? 1 : 0,
        missingToolClaim: missingToolClaimNudgeUsed ? 1 : 0,
        completenessReflectionUsed,
        autoDiagnosticsRuns,
        forceRead: forceReadUsed ? 1 : 0,
        // P2's pacing signal, split by which trigger fired — the eval's
        // "turns from root cause to first edit" metric is meaningless without
        // knowing whether the model was prompted or got there itself.
        commitCause: commitNudgeNarrationUsed ? 1 : 0,
        commitBudget: commitNudgeBudgetUsed ? 1 : 0,
      },
      // Which harness ran (P5) and how much was delegated (P3). Both change
      // the meaning of every other number here, so a result row without them
      // cannot be compared against another.
      harnessProfile: HARNESS_PROFILE,
      exploreCalls: exploreCallsUsed,
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
  //
  // Skipped entirely on a resumed run: the previous segment's exploration is
  // already in `messages`, and the scout would be run against a continuation
  // reply ("continue", "fix it") that carries no topic of its own.
  const exploreStarted = Date.now();
  // Also skipped when the host pre-fetched org context and the request is not
  // a change request: the scout is a code-investigation optimisation, and on a
  // documentation question whose answer is already in the prompt it would
  // spend explorer completions surveying a repo nobody asked about.
  // Deliberately NOT skipped for write intent ("can you fix it" after a ticket
  // answer) — there the codebase is the subject, whatever was pre-fetched.
  // Cost of a wrong skip: the model explores by hand with the same tools —
  // slower, never less capable.
  const docPrefetched = searchResults.length > 0;
  const exploration = resume || (docPrefetched && !WRITE_INTENT_RUN)
    ? null
    : await runExplorationPhase(
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
          // The explorers share the run's cache key too: their own prompt is a
          // stable system preamble plus a file pack, and pinning them to the
          // same upstream keeps that preamble warm across clusters.
          extraBody: { ...(isOpenRouter ? { reasoning: { effort: 'low' } } : {}), ...PROMPT_CACHE_FIELDS },
        },
        isLocalProvider,
        // Scout the ticket's own words, not just the prompt's: a seeded ticket
        // prompt carries only an ID and a title, and the symptom vocabulary
        // ("strike-through", "unit label") lives in the description/criteria.
        ticketContext
          ? [ticketContext.title, ticketContext.description, ticketContext.acceptanceCriteria]
              .filter(Boolean)
              .join('\n')
          : undefined
      );
  if (exploration) {
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
  }

  for (let i = 0; i < iterationCap; i++) {
    // ── Wall clock: the only thing that ENDS a healthy run early ──
    if (Date.now() - runStarted > RUN_WALL_CLOCK_MS) {
      console.log(`[agent] wall clock reached after ${i} turns — concluding`);
      stopReason = 'clock';
      break;
    }
    // Snapshot for the progress check at the end of this round. Nothing
    // between here and there mutates these except this round's tool calls.
    const writesBeforeTurn = writesApplied;
    const readPathsBeforeTurn = readPaths.size;
    const seenResultsBeforeTurn = seenToolResults.size;

    // ── Convergence pressure (see writePressure.ts) ──
    // A run with nowhere left to put results, or one that has stopped learning
    // anything, loses the tools that find somewhere new to look. Structural,
    // not prose: the commit nudge already ASKS the model to stop reading, and
    // a model that wants one more search does one more search. Both triggers
    // are measured — never inferred from what the user typed. Announced the
    // round it happens, or the model reports its tools as broken.
    const narrow = shouldNarrowToConclude({
      contextExhausted: contextNow.exhausted,
      stagnant: isStagnant(turnsWithoutProgress),
      investigationCallsWithoutWrite,
      writesApplied,
    });
    if (narrow && !commitNarrowingApplied) {
      commitNarrowingApplied = true;
      messages.push({ role: 'user', content: COMMIT_NARROWED_NOTICE });
      console.log(
        `[agent] convergence pressure at turn ${i + 1}: discovery tools withdrawn ` +
          `(context ${contextNow.usedPct}%, ${turnsWithoutProgress} turns without progress, ` +
          `${investigationCallsWithoutWrite} investigation calls, 0 edits)`
      );
    }
    const turnToolDefs = narrow ? narrowToCommitTools(SCOPED_TOOL_DEFS) : SCOPED_TOOL_DEFS;

    const turnStarted = Date.now();
    syncTranscript();
    const outcome = await runToolTurn(messages, model, baseURL, apiKeys, true, undefined, undefined, turnToolDefs);
    const thoughtMs = Date.now() - turnStarted;

    // ── What the conversation actually costs, from the provider itself ──
    // `usage.prompt_tokens` is the ground truth; only the window size is an
    // assumption, and a prompt the provider ACCEPTED proves the window is at
    // least that big, so the assumption is corrected upward before use.
    if (outcome.usage.promptTokens > 0) {
      windowTokens = observedWindowFloor(windowTokens, outcome.usage.promptTokens);
      contextNow = contextState({ promptTokens: outcome.usage.promptTokens, windowTokens });
      parentPort?.postMessage({
        type: 'context',
        usedTokens: contextNow.usedTokens,
        windowTokens: contextNow.windowTokens,
        usedPct: contextNow.usedPct,
        remainingPct: contextNow.remainingPct,
        // Truncated-result count, so the meter can say the context has already
        // been trimmed once. Not summarizing compaction — see TODO.md.
        compactions: toolResultLog.filter((e) => e.compacted).length,
        // Where that occupancy came from. The total above is the provider's;
        // this split is derived from the same payload it counted, so the two
        // always agree — see contextBreakdown.ts.
        segments: contextBreakdown({
          messages,
          toolDefs: turnToolDefs,
          promptTokens: outcome.usage.promptTokens,
        }),
      });
    }

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
      // A finished, verified report: writes landed, diagnostics ran after the
      // last one, and the answer is shaped like the FINAL REPORT FORMAT. The
      // phrasing gates below stand down for it (a courteous "let me know if
      // you want X pulled into a follow-up" under Notes is not a stall), and
      // it is what the cap delivers if the run never gets to end cleanly.
      const finishedReport =
        writesApplied > 0 &&
        writesSinceDiagnostics === 0 &&
        autoVerify.settled() &&
        REPORT_SHAPED_RE.test(outcome.content);
      if (finishedReport) lastReportAnswer = outcome.content;
      // The model wants to finish — but unverified writes block that. Run
      // get_diagnostics OURSELVES as a synthetic tool exchange (deterministic,
      // unlike nudging): the model then sees the result and either confirms or
      // fixes what it broke. Once per run — a model that ignores the result
      // shouldn't loop forever.
      if (writesSinceDiagnostics > 0 && autoDiagnosticsRuns < AUTO_DIAGNOSTICS_LIMIT) {
        autoDiagnosticsRuns++;
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
      // Diagnostics are clean but the change is still unverified: run the
      // lint / typecheck / tests that cover each changed file ourselves (see
      // autoVerify above), batched into one synthetic round.
      const checkBatch = autoVerify.nextBatch();
      if (checkBatch.length > 0) {
        const round = ++autoVerifyRounds;
        const jobs = planCheckJobs(checkBatch);
        const calls = jobs.map((job, n) => ({
          id: `auto_checks_${round}_${n}`,
          type: 'function' as const,
          function: { name: 'run_checks', arguments: JSON.stringify(job.args) },
        }));
        messages.push({ role: 'assistant', content: outcome.content || null, tool_calls: calls });
        const failures: string[] = [];
        const brokenRunners: string[] = [];
        const runJob = async (job: CheckJob): Promise<unknown> => {
          // The primary is marked BEFORE the call, so a check that keeps
          // throwing costs one round rather than repeating forever. The rest
          // of a batched lint are marked from what the host says it actually
          // covered — a path dropped for living in another package must stay
          // pending, not be recorded as verified by a process that skipped it.
          autoVerify.markRunning(job.args.path, job.args.kind);
          const transportId = randomUUID();
          parentPort?.postMessage({
            type: 'tool_status',
            id: transportId,
            name: 'run_checks',
            arguments: { ...job.args, auto: true },
          });
          let result: unknown;
          try {
            result = await requestTool('run_checks', job.args, transportId);
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
          const covered = (result as { coveredPaths?: unknown } | null)?.coveredPaths;
          // No coveredPaths in the result means the batch was not honoured —
          // only the primary ran. Leaving the rest pending re-runs them next
          // round; assuming they passed would report unlinted files as clean.
          const coveredSet = new Set((Array.isArray(covered) ? covered : []).map(String));
          for (const c of job.covers) {
            if (c.path !== job.args.path && coveredSet.has(c.path)) autoVerify.markRunning(c.path, c.kind);
          }
          return result;
        };
        // Lint and typecheck are single-process and cheap on memory, so they
        // overlap; tests stay strictly serial. A jest run already forks
        // cores-1 workers, and two of them at once is how ticket #1534774 put
        // the machine into swap — concurrency here must not re-open that.
        const results: unknown[] = new Array(jobs.length);
        await Promise.all(
          jobs.map(async (job, n) => {
            if (job.args.kind === 'test') return;
            results[n] = await runJob(job);
          })
        );
        for (let n = 0; n < jobs.length; n++) {
          if (jobs[n].args.kind === 'test') results[n] = await runJob(jobs[n]);
        }
        for (let n = 0; n < jobs.length; n++) {
          const job = jobs[n];
          const verdict = autoVerify.noteOutcome(job.args.kind, results[n] as CheckResultLike);
          if (verdict === 'failed') failures.push(`${job.args.kind} for ${job.covers.map((c) => c.path).join(', ')}`);
          if (verdict === 'unavailable') brokenRunners.push(job.args.kind);
          messages.push({ role: 'tool', tool_call_id: calls[n].id, content: serializeToolResult(results[n]) });
          recordToolResult('run_checks', i, messages[messages.length - 1].content);
        }
        if (failures.length > 0) {
          messages.push({
            role: 'user',
            content:
              `VERIFICATION FAILED — ${failures.join('; ')} exited non-zero (output above). The task is NOT complete. ` +
              'Read the failure output, find the cause in the code, and FIX it now with your write tools — the checks re-run after your fix. ' +
              'If the failure is genuinely unrelated to your change (it fails the same way on code you did not touch), say so explicitly and name the evidence; do not assume it. ' +
              'Do not report success, and do not answer with a plan for fixing it — apply the fix.',
          });
        } else if (brokenRunners.length > 0) {
          // The runner never started (no config, missing script, timeout).
          // Say so plainly, or the model reads the non-zero exit above as its
          // own breakage and starts "fixing" the repo's tooling.
          messages.push({
            role: 'user',
            content:
              `The ${[...new Set(brokenRunners)].join(' and ')} runner could not start in this workspace (see the output above) — that is this project's tooling, NOT your change, and not yours to fix. ` +
              'Do not edit config or install anything to make it run. Finish your answer, and record that check as "could not verify" with the reason.',
          });
        }
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
      const claimsChanges = CLAIMS_CHANGES_RE.test(outcome.content);
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
      // The answer declares itself blocked because a write tool is "not
      // exposed"/"unavailable" — categorically false: TOOL_DEFS is sent whole
      // (edit_file/create_file/delete_file included) on every request of this
      // loop. Observed live wrapped in an otherwise-valid "## Blocked" section,
      // which would make the structural ticket gate stand down — so this
      // confrontation runs first and states the fact the model got wrong.
      if (
        PHRASE_GATES &&
        !budgetExhausted &&
        !missingToolClaimNudgeUsed &&
        writesApplied === 0 &&
        MISSING_TOOL_CLAIM_RE.test(outcome.content)
      ) {
        missingToolClaimNudgeUsed = true;
        messages.push({ role: 'assistant', content: outcome.content });
        messages.push({
          role: 'user',
          content:
            'FALSE: edit_file, create_file, and delete_file ARE declared in your tools array on this very request — the same function-calling mechanism that served your read_file and search_codebase calls. You are never given a read-only tool list on a codebase turn. ' +
            'Do not claim a tool is missing; INVOKE it. Call edit_file NOW for each change you described: read_file the target first, then pass oldString copied character-for-character from that output. ' +
            'If an edit_file call errors, report the literal error text — do not translate a failed or unparsed call into "the tool is not exposed".',
        });
        continue;
      }
      // The mirror image of the phantom-changes gate above: instead of claiming
      // changes it never made, the model PROPOSES changes it was already told to
      // make. Without this the conversation can loop indefinitely: plan → "fix
      // it" → plan again.
      //
      // Requires the answer itself to be deferring action — a change plan, or a
      // permission ask on a turn the user already approved. `executeMandate`
      // alone is deliberately NOT enough: an approved plan can be purely
      // investigative ("shall I read the Price element next?"), and a turn that
      // carried that out and answered properly must not be told to start editing.
      if (
        PHRASE_GATES &&
        !planMode &&
        !budgetExhausted &&
        !planInsteadOfExecuteNudgeUsed &&
        writesApplied === 0 &&
        !anyWriteAttempted &&
        (CHANGE_PLAN_RE.test(outcome.content) ||
          (executeMandate && PERMISSION_SEEKING_RE.test(outcome.content)))
      ) {
        planInsteadOfExecuteNudgeUsed = true;
        messages.push({ role: 'assistant', content: outcome.content || '(empty response)' });
        messages.push({
          role: 'user',
          content:
            (executeMandate
              ? 'STOP: the user already approved this plan — that is what their last message meant. You have proposed it again instead of doing it. '
              : 'STOP: you have described the changes you would make, but you never attempted a single one. ') +
            'Make the edits NOW: read_file each target, then call edit_file with oldString copied character-for-character from that output. ' +
            'You do NOT need permission — every write is shown to the user as a diff they approve or reject before it touches disk, so asking first changes nothing except stalling the task. ' +
            'If a minor implementation choice is open and you can name a reasonable default, take that default, implement it, and record the assumption in your final answer — do not end the run to ask about it. ' +
            'If you genuinely cannot proceed, name the one specific blocker instead of restating the plan.',
        });
        continue;
      }
      // A stall answer that NAMES the files it still needs ("grant me another
      // turn to read mapProducts.ts and the BFF mapper") has already done the
      // hard part — locating them. Deterministic beats nudging: read those
      // files NOW as a synthetic tool exchange (same pattern as the forced
      // get_diagnostics above) so the model continues with the data it asked
      // for, instead of the run ending so a human can type "continue".
      // One-shot and capped at 3 files; only fires on a stall-shaped answer,
      // and only for paths never read this run.
      if (PHRASE_GATES && !planMode && !budgetExhausted && !forceReadUsed &&
          (PREMATURE_AMBIGUITY_RE.test(outcome.content) ||
            INCOMPLETE_ANSWER_RE.test(outcome.content) ||
            PERMISSION_SEEKING_RE.test(outcome.content))) {
        const unreadPaths = extractAnswerFilePaths(outcome.content).filter((p) => {
          const norm = normPath(p);
          // Loose suffix matching: the model may write repo-relative paths
          // while reads were recorded workspace-relative (or vice versa).
          for (const read of readPaths) {
            if (read.endsWith(norm) || norm.endsWith(read)) return false;
          }
          return true;
        });
        if (unreadPaths.length > 0) {
          forceReadUsed = true;
          messages.push({
            role: 'assistant',
            content: outcome.content || null,
            tool_calls: unreadPaths.map((path, idx) => ({
              id: `auto_force_read_${idx}`,
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path }) },
            })),
          });
          for (let idx = 0; idx < unreadPaths.length; idx++) {
            const path = unreadPaths[idx];
            const transportId = randomUUID();
            parentPort?.postMessage({ type: 'tool_status', id: transportId, name: 'read_file', arguments: { path, auto: true } });
            let result: unknown;
            try {
              result = await requestTool('read_file', { path }, transportId);
              readPaths.add(normPath(path));
            } catch (e) {
              result = { error: e instanceof Error ? e.message : String(e) };
            }
            messages.push({ role: 'tool', tool_call_id: `auto_force_read_${idx}`, content: serializeToolResult(result, 'read_file') });
            recordToolResult('read_file', i, messages[messages.length - 1].content);
          }
          messages.push({
            role: 'user',
            content:
              'The files your answer said you still needed are now above — read them and FINISH the task in this run: ' +
              'implement the fix (or name the one specific missing product decision), then give ONE complete final answer. ' +
              'Do not ask for another turn.',
          });
          continue;
        }
      }
      // The ambiguity escape hatch, taken early: the answer declares the task
      // unclear or blocked while NAMING reads/searches the model could still
      // do itself ("I have not yet read the PLP components", "I haven't
      // searched Confluence"). That is an unfinished investigation, not an
      // ambiguous ticket — a real ambiguity is a missing product decision,
      // which no amount of reading resolves. Confront once with that
      // distinction; the generic incomplete-answer nudge below handles any
      // relapse. Runs before the other answer gates so the specific
      // confrontation wins over the generic one.
      if (
        PHRASE_GATES &&
        !budgetExhausted &&
        !prematureAmbiguityNudgeUsed &&
        writesApplied === 0 &&
        PREMATURE_AMBIGUITY_RE.test(outcome.content)
      ) {
        prematureAmbiguityNudgeUsed = true;
        messages.push({ role: 'assistant', content: outcome.content });
        messages.push({
          role: 'user',
          content:
            'STOP: you declared the task unclear or blocked while naming investigation YOU can still do yourself — files not yet read, docs not yet searched. That is not ambiguity; it is an unfinished investigation. ' +
            '"Too ambiguous to implement" means a required product or behavior DECISION is missing from the ticket even after reading the ticket, the design docs, and the code. ' +
            'Do the investigation NOW: call search_docs for the design doc, read every file you said you have not read, and trace the code path end to end. ' +
            'Then either implement the fix, or name the one specific missing decision (quote the gap in the ticket). ' +
            'Do NOT offer the user a menu of next steps — investigating is YOUR job, not a choice for them to make.',
        });
        continue;
      }
      // Structural backstop for ticket runs whose prompt mandated implementing
      // the fix: phrasing gates are whack-a-mole (the fourth observed stall on
      // one ticket asked NOTHING — a clean investigation report whose
      // "Assumptions" section described the fix it never applied), but the
      // invariant survives rephrasing: implement mandate + zero writes + no
      // "## Blocked" / "## No change needed" section = the run is not done.
      if (
        !planMode &&
        !budgetExhausted &&
        !ticketCompletionNudgeUsed &&
        ticketContext &&
        IMPLEMENT_MANDATE_RE.test(prompt) &&
        writesApplied === 0 &&
        !anyWriteAttempted &&
        !TICKET_TERMINAL_RE.test(outcome.content)
      ) {
        ticketCompletionNudgeUsed = true;
        messages.push({ role: 'assistant', content: outcome.content });
        messages.push({
          role: 'user',
          content:
            'STOP: this ticket run was instructed to IMPLEMENT the fix, and you are ending it with ZERO edits, no "## Blocked" section, and no "## No change needed" section. An investigation report — however thorough — is not a valid ending. ' +
            'This run has exactly three valid endings: (1) apply the fix NOW with read_file + edit_file (every write is shown to the user as a diff to approve; implementation choices with a reasonable default are yours to make — record them under "Assumptions" AFTER implementing, never instead of it); ' +
            '(2) if the code already satisfies the acceptance criteria, end with a "## No change needed" section citing file:line evidence; ' +
            '(3) if a required product or behavior decision is genuinely missing from the ticket, end with a "## Blocked" section quoting the exact gap. Pick one and finish.',
        });
        continue;
      }
      // A "final answer" that names tools is almost always a narrated plan,
      // not an answer ("I will use find_files to locate..."). Same for an
      // empty response before any tool has run. Push back and let it retry.
      // Split by kind: an EMPTY answer before any tool ran is a state fact and
      // is checked in both profiles; "the answer happens to name a tool" is
      // phrasing, and on a capable model it is usually a legitimate mention
      // ("read_file returns numbered lines") rather than a narrated plan.
      const mentionsTool = PHRASE_GATES && [...KNOWN_TOOL_NAMES].some((n) => outcome.content.includes(n));
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
      // the model is asking the user to type "continue". One that ends by asking
      // permission ("shall I go ahead?") strands the task the same way. Send
      // either back to finish the job itself. Skipped once the tool budget is
      // gone: at that point continuing is impossible and a partial answer is the
      // best we have.
      const announcesWork = !finishedReport && INCOMPLETE_ANSWER_RE.test(outcome.content);
      // Only armed when the turn was actually supposed to act — otherwise a
      // polite "let me know if you want me to dig further" on a complete
      // read-only answer would burn a round trip.
      const seeksPermission =
        !planMode &&
        !finishedReport &&
        PERMISSION_SEEKING_RE.test(outcome.content) &&
        // A ticket-grounded run was seeded with "implement the fix" — ending it
        // on a permission ask or an options menu is always wrong there, even
        // before any write was attempted (observed live: a fresh ticket run
        // ended with "which of these should I do next?" after one directory
        // listing, and none of the other arming conditions were true yet).
        (executeMandate || anyWriteAttempted || !!ticketContext || CHANGE_PLAN_RE.test(outcome.content));
      if (
        PHRASE_GATES &&
        !budgetExhausted &&
        (announcesWork || seeksPermission) &&
        incompleteAnswerNudgesUsed < MAX_PLAN_NUDGES
      ) {
        incompleteAnswerNudgesUsed++;
        messages.push({ role: 'assistant', content: outcome.content });
        messages.push({
          role: 'user',
          content: seeksPermission
            ? 'Your answer ends by asking for permission or confirmation. Do not — you already have it, and every file write is shown to the user as a diff they approve or reject before it is applied, so there is nothing left to ask about. ' +
              'Carry out the remaining work NOW with your tools, then give ONE complete final answer reporting what you did.'
            : 'Your answer says something still needs to be examined or checked — do NOT stop to announce remaining work, and do NOT wait for the user to say "continue". ' +
              'Do the remaining examination NOW with your tools, then give ONE complete final answer that includes what you find.',
        });
        continue;
      }
      // One-shot completeness reflection before accepting a tool-grounded
      // answer (see completenessReflectionUsed above). The nudged turn passes
      // back through every gate here, so a reflection that surfaces new work
      // still gets diagnostics/honesty checks before the run can end.
      if (
        PHRASE_GATES &&
        !completenessReflectionUsed &&
        // Optional polish, not an honesty gate — on a slow model this extra
        // round trip costs another minute and is the first thing to drop.
        !slowModelMode &&
        !budgetExhausted &&
        toolCallsExecuted > 0 &&
        outcome.content.trim() &&
        // A finished report whose Verification section is backed by an actual
        // post-write run_command has already done what the write reflection
        // asks ("re-run the test now") — asking again just costs a round trip
        // and, on a slow model, the rest of the iteration budget.
        !(finishedReport && commandRunSinceWrite)
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
      // no conclusive match, wrote nothing, and returned empty content). A
      // model that only emitted leaked tool-call syntax (unrecognized <invoke>
      // name, or GMI Cloud/MiniMax-M3's marker debris around one the salvage
      // pass above already consumed) counts as empty too — there's no prose
      // left once that's stripped, so showing it raw would just dump garbage.
      const cleanedContent = stripLeakedToolCallSyntax(outcome.content);
      if (!cleanedContent && toolCallsExecuted > 0 && !summaryNudgeUsed) {
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
      const deliverable = finalizeDeliverable(cleanedContent);
      if (deliverable) parentPort?.postMessage({ type: 'chunk', content: deliverable });
      emitMetrics();
      parentPort?.postMessage({ type: 'done', content: deliverable, writesApplied, stallShaped: !planMode && writesApplied === 0 && (isStallShapedAnswer(deliverable) || CLAIMS_CHANGES_RE.test(deliverable)) });
      return;
    }

    // The model paused to "think" between tool batches — surface it like the
    // step timeline expects ("Thought for 2s"), then any prose it wrote
    // alongside its tool calls (previously swallowed into `messages` only).
    parentPort?.postMessage({ type: 'thought', ms: thoughtMs });
    if (!salvaged) {
      const noteContent = stripLeakedToolCallSyntax(outcome.content);
      if (noteContent) parentPort?.postMessage({ type: 'agent_note', content: noteContent });
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
            // This hand-back exists to hand over copy-ready text, so the
            // line-number prefixes read_file adds come straight back off
            // again — telling the model to copy "character-for-character"
            // from numbered content would be a trap.
            let content = stripLineNumbers(String(readResult?.content ?? ''));
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
      // `explore` runs INSIDE the worker — there is no host-side tool of that
      // name (chatService's dispatch would throw "Unknown tool"). Its whole
      // purpose is that its reads never reach `messages`: only the returned
      // claim list is serialized into the caller's context, and its tool
      // output is charged to its own budget, not this run's.
      if (tc.name === 'explore') {
        if (exploreCallsUsed >= MAX_EXPLORE_CALLS) {
          return {
            error:
              `The explore budget for this run is spent (${MAX_EXPLORE_CALLS} delegated investigation(s) used). ` +
              'Investigate directly with search_codebase and read_file, or act on what you already know.',
          };
        }
        exploreCallsUsed++;
        const { question, scope } = (parsedArgs ?? {}) as { question?: unknown; scope?: unknown };
        const sub = await runExploreSubagent(
          String(question ?? ''),
          typeof scope === 'string' ? scope : undefined,
          {
            runTurn: async (subMessages, toolNames, withTools) => {
              const defs = SCOPED_TOOL_DEFS.filter((d) => toolNames.includes(d.function.name));
              const o = await runToolTurn(subMessages as any[], model, baseURL, apiKeys, withTools, 4096, true, defs);
              return {
                content: o.content,
                toolCalls: o.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
                apiCalls: o.apiCalls,
                promptTokens: o.usage.promptTokens,
                completionTokens: o.usage.completionTokens,
              };
            },
            requestTool: (name, args) => requestTool(name, args, randomUUID()),
            onProgress: (label) =>
              parentPort?.postMessage({ type: 'tool_step_update', id: transportId, stepStatus: 'running', summary: label }),
          },
          defaultExploreConfig(isLocalProvider)
        );
        // Its API calls are real spend and belong in this run's metrics even
        // though its tool output does not belong in this run's context.
        apiCallsTotal += sub.apiCalls;
        promptTokensTotal += sub.promptTokens;
        completionTokensTotal += sub.completionTokens;
        // Deliberately NOT added to readPaths: the sub-agent read these files,
        // this model did not. An edit built from a citation alone is still an
        // oldString from memory, so the read-before-edit guard must still fire
        // and hand over the real text.
        parentPort?.postMessage({
          type: 'tool_step_update',
          id: transportId,
          stepStatus: 'done',
          summary: `${sub.claimsKept} finding(s) from ${sub.filesRead.length} file(s), ${sub.toolCalls} lookup(s)`,
        });
        return {
          findings: sub.report,
          filesRead: sub.filesRead,
          lookups: sub.toolCalls,
          ...(sub.claimsDropped ? { claimsDropped: sub.claimsDropped } : {}),
          ...(sub.budgetExhausted ? { note: 'The investigation hit its own budget — findings may be partial.' } : {}),
          reminder: 'These are leads, not verified truth. read_file the exact range before editing against it.',
        };
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
    // Execute in the order the model asked for, but let ADJACENT non-barrier
    // calls overlap. A round of [edit A, read B, read C] used to run all three
    // back to back because one of them mutated; now the edit runs alone and
    // B and C run together. Consecutive-run batching (rather than "all reads
    // first") is what keeps read-after-write honest: a read the model placed
    // after its edit still sees the edited file.
    const results: unknown[] = [];
    let batch: BufferedToolCall[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      results.push(...(batch.length === 1 ? [await executeOne(batch[0])] : await Promise.all(batch.map(executeOne))));
      batch = [];
    };
    for (const tc of toolCalls) {
      if (BARRIER_TOOL_NAMES.has(tc.name)) {
        await flush();
        results.push(await executeOne(tc));
      } else {
        batch.push(tc);
      }
    }
    await flush();

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
        content: serializeToolResult(stripImagesForToolText(tc.name, rawResult), tc.name),
      });
      recordToolResult(tc.name, i, messages[messages.length - 1].content);

      const ticketImages = (rawResult as { images?: { dataUrl: string }[] } | null)?.images;
      // Only the ones the model has not already been shown — see
      // sentImageDataUrls. The tool text still reports imageCount/imageNames
      // for all of them (stripImagesForToolText), so nothing is hidden.
      const freshTicketImages = tc.name === 'get_ticket' && ticketImages?.length ? unsentImages(ticketImages) : [];
      if (freshTicketImages.length) {
        const ticketId = (rawResult as { id?: unknown } | null)?.id ?? '';
        pendingImageTurns.push({
          role: 'user',
          content: [
            { type: 'text', text: `Image(s) attached to ticket #${ticketId}:` },
            ...imagesToContentParts(freshTicketImages),
          ],
        });
      }

      const failed = !!(results[idx] as { error?: unknown } | null)?.error;
      if (!failed) okToolResults++;
      let argPath = '';
      try {
        argPath = normPath((JSON.parse(tc.args || '{}') as { path?: string }).path);
      } catch {
        /* unparseable args — nothing to derive from them */
      }
      if (FILE_WRITE_TOOL_NAMES.has(tc.name)) {
        anyWriteAttempted = true;
        if (!failed) {
          writesApplied++;
          writesSinceDiagnostics++;
          commandRunSinceWrite = false;
        }
        if (argPath) lastWriteOutcome.set(argPath, !failed);
        // The file changed, so any check that ran against its old content is
        // void — re-arming it is what turns a failing check into a
        // fix-then-re-verify cycle instead of a one-shot complaint.
        if (!failed) autoVerify.noteWrite(argPath, { deleted: tc.name === 'delete_file' });
      }
      if (tc.name === 'get_diagnostics') writesSinceDiagnostics = 0;
      if (tc.name === 'run_checks' && !failed && argPath) {
        // The model verified this file itself — don't re-run that check.
        let kind = 'test';
        try {
          const parsed = (JSON.parse(tc.args || '{}') as { kind?: unknown }).kind;
          if (typeof parsed === 'string') kind = parsed;
        } catch {
          /* unparseable args — the tool's own default applies */
        }
        autoVerify.noteCheckRan(argPath, kind);
      }
      if ((tc.name === 'run_command' || tc.name === 'run_checks') && !failed) commandRunSinceWrite = true;
      if (writesApplied === 0 && (tc.name === 'read_file' || DISCOVERY_TOOL_NAMES.has(tc.name))) {
        investigationCallsWithoutWrite++;
      }
    });
    messages.push(...pendingImageTurns);
    toolCallsExecuted += toolCalls.length;

    // ── Did this turn learn anything? (contextBudget.ts) ──
    // The runaway backstop that replaces the turn cap. "Progress" is new
    // information or a change to the workspace — deliberately NOT "the model
    // called a tool", because issuing the same failing search forever is
    // exactly the loop this has to catch. Counted from tool results, so it
    // cannot be talked around.
    const advanced =
      writesApplied > writesBeforeTurn ||
      readPaths.size > readPathsBeforeTurn ||
      seenToolResults.size > seenResultsBeforeTurn;
    turnsWithoutProgress = advanced ? 0 : turnsWithoutProgress + 1;
    if (!advanced) {
      console.log(`[agent] turn ${i + 1} surfaced nothing new (${turnsWithoutProgress} in a row)`);
    }

    // ── Verification reserve (see writePressure.ts) ──
    // An edit that lands in the last turns would otherwise be delivered
    // unverified, or trigger the cap between the write and the check —
    // exactly the ending the commit pressure above is meant to prevent, moved
    // later. Granted once, bounded, and only after something was written.
    const reservedCap = capWithVerificationReserve({
      turnIndex: i,
      iterationCap,
      hardCap: MAX_TOOL_ITERATIONS + VERIFICATION_RESERVE_TURNS,
      writesApplied,
      reserveUsed: verificationReserveUsed,
    });
    if (reservedCap !== iterationCap) {
      verificationReserveUsed = true;
      console.log(
        `[agent] verification reserve: cap ${iterationCap} → ${reservedCap} (write landed at turn ${i + 1})`
      );
      iterationCap = reservedCap;
    }

    // ── Commit nudge ──
    // The narration trigger is the precise moment observed on #1534774: the
    // model wrote "Now I have a complete understanding. The fix needs to
    // clear the storage data" with ten turns still in hand, and spent them
    // all reading. The budget trigger is the backstop for a run that never
    // says it out loud. See commitNudgeTriggers (answerGates) for the full
    // set of conditions and why each is there.
    const commit = commitNudgeTriggers({
      assistantProse: outcome.content || '',
      turnIndex: i,
      iterationCap,
      writesApplied,
      writeIntent: WRITE_INTENT_RUN,
      planMode,
      budgetExhausted,
      narrationUsed: commitNudgeNarrationUsed,
      budgetUsed: commitNudgeBudgetUsed,
    });
    if (commit.fire) {
      if (commit.narration) commitNudgeNarrationUsed = true;
      if (commit.budget) commitNudgeBudgetUsed = true;
      messages.push({
        role: 'user',
        content:
          `${HARNESS_CHECKPOINT_PREFIX} ${commit.turnsLeft} tool turn(s) left in this run, and zero file edits so far. ` +
          'Reading is not progress once you can name the cause. State the root cause in ONE line with its file:line, then make your NEXT tool call an edit — re-read only the exact lines you need to copy for oldString. ' +
          'If you genuinely cannot edit yet, say in one line what single fact is missing and get it in your next call. ' +
          'Running out of turns is not a blocker and never a reason to report one: an applied fix with a stated assumption beats a perfect investigation nobody can ship.',
      });
    }

    // ── Running out of room ends the run; running out of TURNS no longer does ──
    // Automatic summarizing compaction (which would let a run continue past a
    // full context, the way Claude Code does) is deliberately not built yet —
    // see TODO.md. Until it is, a genuinely full context is a real stop, and
    // the honest one: the model cannot be shown any more. Note this is a much
    // later stop than the old 33-turn cap, and the narrowing above has already
    // pushed the run to conclude before it gets here.
    // Relieve pressure when the MEASURED context says to (75% of the window),
    // or when the char backstop trips because the provider reported no usage.
    // Truncating old results is lossy, so it must not start earlier than the
    // real limit demands — which is precisely what the old flat char budget
    // did, at about 35% of the window.
    if (contextNow.shouldCompact || budgetExhausted) {
      compactOldToolResults(i);
      if (MAX_TOTAL_TOOL_CHARS - toolCharsUsed >= MAX_TOOL_RESULT_CHARS) budgetExhausted = false;
    }
    // The one real stop: no room left to show the model anything more.
    if (contextNow.exhausted) {
      console.log(`[agent] context full at turn ${i + 1} (${contextNow.usedPct}%) — concluding`);
      stopReason = 'context';
      break;
    }
    // Backstop: truncation could not free room for even one more result.
    if (budgetExhausted) {
      stopReason = 'budget';
      break;
    }
  }

  // Past the loop, so one of the limit exits was taken — and if none assigned,
  // the `for` condition itself ran out, which IS the step limit.
  const limitReason: LimitKind = stopReason === 'none' ? 'steps' : stopReason;
  stopReason = limitReason;

  // The run already produced a finished, verified report and only the gates'
  // follow-up rounds (reflection, re-verification) consumed the rest of the
  // budget. Deliver that report as-is: one more forced turn would only make
  // the model write "step limit reached" over a task that is done (observed
  // live on ticket 1516750 — the report opened with "## Step limit reached —
  // no further work to do" and spent its first paragraph explaining the
  // previous turn had already finished).
  if (lastReportAnswer && writesApplied > 0 && writesSinceDiagnostics === 0) {
    const deliverable = finalizeDeliverable(stripLeakedToolCallSyntax(lastReportAnswer));
    if (deliverable) {
      parentPort?.postMessage({ type: 'chunk', content: deliverable });
      syncTranscript();
      emitMetrics();
      parentPort?.postMessage({ type: 'done', content: deliverable, writesApplied, stallShaped: false });
      return;
    }
  }

  // One of the four loop exits was taken: force a final answer without tools
  // so the user always gets a response instead of hanging or erroring. Tell
  // the model WHICH limit ended the run — without this it discovers its tools
  // are gone and invents a reason ("over budget, then tool access was cut off"
  // — observed live at 9% budget), and that fabrication ends up in the
  // user-facing answer. Which is also why the reason has to be the REAL one:
  // `stopReason` is set at each break rather than guessed from
  // `budgetExhausted`, so a clock or context ending is no longer reported as a
  // step limit (#1384667).
  messages.push({
    role: 'user',
    content:
      // Built from the resumeHygiene prefixes: a resumed run strips this
      // message, because the limit it announces belongs to THIS segment only.
      `${HARNESS_LIMIT_PREFIX[limitReason]}: ${toolCallsExecuted} tool call(s) over ${perTurn.length} turns (cap ${iterationCap}).` +
      ' No further tools can run this turn. Answer now from what you already gathered. ' +
      'If the task itself is complete (fix applied and verified), do NOT mention the limit at all — deliver the final report in the required format as if the run ended normally. ' +
      'Only if the task is unfinished, be exact about why you stopped — say "' +
      HARNESS_LIMIT_PHRASE[limitReason] +
      '"; do NOT claim tool access was revoked, cut off, or broken. ' +
      // Running out of steps is a HARNESS limit, not a fact about the ticket.
      // Observed live on #1534774: the model relabelled the cap hit as
      // "## 🚫 Blocked — storage entry lacks a signal…" and offered the user
      // four candidate fixes to choose between, which reads to everyone
      // downstream as a product question the ticket failed to answer. It also
      // took this prompt's own "list the files still unread" instruction and
      // rendered it as a paragraph of homework for the next run.
      'Do NOT use the "## Blocked" heading for this: a harness limit is not a missing product decision, and "## Blocked" claims the second. ' +
      `Put that reason IN the status heading, after what is left — e.g. "## ⚠️ Partially done — run_checks not run · ${HARNESS_LIMIT_PHRASE[limitReason]} after the edits" — a heading that names only what is left ("run_checks not run yet") tells the user nothing they can act on. ` +
      'If you had already identified the fix, say so plainly under that heading and state what the edit would be, in one or two lines; if the task is a bug, still give the "### Root cause" section — the user wants to know what was wrong even when the fix is unfinished. ' +
      'Then list only the specific files still unread — the run resumes with everything gathered so far carried over, so keep it to file paths, not instructions.',
  });
  let finalStarted = Date.now();
  syncTranscript();
  // This turn writes the whole final report against a long tool history, and
  // it is the longest single completion of the run. It cannot be streamed —
  // the harness rewrites the text before delivery (preamble stripping, the
  // honesty stamp, harness-limit notes), and streaming the raw draft would put
  // an unstamped completion claim on screen ahead of its correction. So say
  // what is happening instead of leaving the timeline silent for it.
  parentPort?.postMessage({ type: 'composing' });
  let finalOutcome = await runToolTurn(messages, model, baseURL, apiKeys, false);
  noteTurn(Date.now() - finalStarted, finalOutcome, 0, false);
  // Tools are off for this turn — it exists purely to force a prose answer —
  // so tool-call-shaped content can never be executed here even when it does
  // parse. Treat it the same as an empty response: GMI Cloud/MiniMax-M3 in
  // particular tends to keep emitting its <invoke> markup out of habit even
  // with no tool schema in the request.
  if (!finalOutcome.content.trim() || hasLeakedToolCallSyntax(finalOutcome.content)) {
    // Empty even after runToolTurn's own reasoning-budget retry — give it one
    // more explicit nudge before giving up, since a forced no-tools turn with
    // a long tool-result history is exactly the shape that starves smaller
    // output budgets.
    messages.push({ role: 'assistant', content: EMPTY_RESPONSE_PLACEHOLDER });
    messages.push({
      role: 'user',
      content: `${HARNESS_PROSE_RETRY_PREFIX} ${toolCallsExecuted} tool result(s) already gathered above. Do not call any more tools.`,
    });
    finalStarted = Date.now();
    syncTranscript();
    finalOutcome = await runToolTurn(messages, model, baseURL, apiKeys, false);
    noteTurn(Date.now() - finalStarted, finalOutcome, 0, false);
  }
  const finalText = stripLeakedToolCallSyntax(finalOutcome.content);
  if (!finalText) {
    // Still nothing — telling the user "Done" here would be a lie (nothing
    // was answered, and if writesApplied === 0, nothing changed either). Say
    // so plainly instead of letting the webview's generic fallback text imply
    // the task succeeded.
    syncTranscript();
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
  const finalDeliverable = finalizeDeliverable(finalText);
  parentPort?.postMessage({ type: 'chunk', content: finalDeliverable });
  emitMetrics();
  // This exit is the budget/iteration-forced final answer — the one path
  // where the honesty gates were deliberately skipped, so the stall tag is
  // how the host learns a resume is worth it (a fresh worker = fresh budget).
  // This answer exists only because the run ran out of steps or budget, so
  // the phrasing gates are the wrong instrument here — all five of them
  // missed #1534774's cap-hit answer, whose "## Blocked" heading then read as
  // a legitimate ending and cost the host its one-shot auto-resume. A
  // write-intent run that ends here having written nothing is unfinished as a
  // matter of arithmetic (see isUnfinishedWriteRun), whatever it says about
  // itself; the host resumes it once with a fresh budget and the reads it
  // already paid for.
  const forcedExitStalled =
    isUnfinishedWriteRun(finalDeliverable, {
      writesApplied,
      // From what the run did and said — see writeWasExpected. WRITE_INTENT_RUN
      // is the last of four terms there, so a prompt phrasing it misses still
      // reaches the right verdict through the facts.
      writeExpected: writeWasExpected({
        answer: finalDeliverable,
        anyWriteAttempted,
        executeMandate,
        writeIntent: WRITE_INTENT_RUN,
      }),
      planMode,
    }) ||
    (!planMode &&
      writesApplied === 0 &&
      (isStallShapedAnswer(finalDeliverable) || CLAIMS_CHANGES_RE.test(finalDeliverable)));
  parentPort?.postMessage({ type: 'done', content: finalDeliverable, writesApplied, stallShaped: forcedExitStalled });
}

// Start processing
generateResponse();
