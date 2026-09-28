import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import { COPILOT_PROVIDER, STORAGE_KEYS } from '../../constants';
import { forwardToCopilot, getDirectCopilotContextWindow, initDirectCopilot, usesDirectCopilot } from './copilotDirect';

/**
 * GitHub Copilot as a model provider, through VS Code's Language Model API.
 *
 * Every inference call site (the worker's agent loop, exploration, the intent
 * classifier, deployment) speaks OpenAI chat completions to a base URL + key,
 * and `vscode.lm` only exists in the extension host — not in the worker. So
 * rather than teach each call site a second protocol, this is a loopback
 * OpenAI-compatible endpoint that translates to `vscode.lm`: Copilot is then
 * just another base URL, and getLlmSettings() hands out this URL and token.
 *
 * - Bound to 127.0.0.1 with a random per-session bearer token, so no other
 *   process on the machine can spend the user's Copilot quota.
 * - The desktop host has no `vscode.lm` (vscode-compat exports it as
 *   undefined); there the bridge forwards to Copilot directly instead — an
 *   unofficial, opt-in path, see copilotDirect.ts. Forks without Copilot list
 *   no models.
 * - Copilot's first request shows VS Code's own consent dialog; requests count
 *   against the user's Copilot plan.
 */

/** Copilot also serves small utility models (12K input) that can't hold an agent transcript. */
const MIN_INPUT_TOKENS = 100_000;
const COPILOT_EXTENSION_ID = 'GitHub.copilot-chat';

export interface CopilotBridge {
  baseUrl: string;
  token: string;
}

let bridge: CopilotBridge | undefined;
let starting: Promise<CopilotBridge> | undefined;

/** The running bridge, or undefined when it hasn't been started (callers treat that as "no key"). */
export function getCopilotBridge(): CopilotBridge | undefined {
  return bridge;
}

/** Start the bridge once; later calls return the same one. */
export function ensureCopilotBridge(): Promise<CopilotBridge> {
  if (bridge) return Promise.resolve(bridge);
  starting ??= new Promise<CopilotBridge>((resolve, reject) => {
    const token = crypto.randomBytes(32).toString('hex');
    const server = http.createServer((req, res) => {
      handle(req, res, token).catch((err) => sendError(res, err));
    });
    server.on('error', (err) => {
      starting = undefined;
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      bridge = { baseUrl: `http://127.0.0.1:${port}/v1`, token };
      resolve(bridge);
    });
    // Never keep the extension host alive just for this listener.
    server.unref();
  });
  return starting;
}

/** On activation: bring the bridge up if Copilot is already the selected provider. */
export function startCopilotBridgeIfSelected(context: vscode.ExtensionContext): void {
  initDirectCopilot(context);
  const model = context.globalState.get(STORAGE_KEYS.MODEL) as any;
  if (model?.state?.selectedModelProvider?.provider !== COPILOT_PROVIDER) return;
  ensureCopilotBridge().catch((err) => console.error('[copilotBridge] failed to start:', err));
}

/** Copilot's input limit for a model, which is often below the model's native window. */
export async function getCopilotContextWindow(modelId: string): Promise<number | undefined> {
  if (usesDirectCopilot()) return getDirectCopilotContextWindow(modelId);
  try {
    const models = await listCopilotModels();
    return (models.find((m) => m.id === modelId) ?? models.find((m) => m.family === modelId))?.maxInputTokens;
  } catch {
    return undefined;
  }
}

/** Copilot chat models big enough for an agent transcript; empty when not signed in. */
export async function listCopilotModels(): Promise<vscode.LanguageModelChat[]> {
  // Copilot Chat activates lazily (on a chat session), and until it does it
  // registers no models — wake it before asking.
  const ext = vscode.extensions.getExtension(COPILOT_EXTENSION_ID);
  if (ext && !ext.isActive) await ext.activate();
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  return models.filter((m) => m.maxInputTokens >= MIN_INPUT_TOKENS);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, token: string) {
  if (req.headers.authorization !== `Bearer ${token}`) {
    return sendJson(res, 401, { error: { message: 'Invalid bridge token' } });
  }
  if (usesDirectCopilot() && (req.url === '/v1/models' || req.url === '/v1/chat/completions')) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return forwardToCopilot(req.url.slice('/v1'.length), raw, res);
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    const models = await listCopilotModels();
    return sendJson(res, 200, {
      object: 'list',
      data: models.map((m) => ({ id: m.id, object: 'model', owned_by: 'copilot', max_input_tokens: m.maxInputTokens })),
    });
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return chatCompletion(JSON.parse(raw), req, res);
  }
  sendJson(res, 404, { error: { message: `Not found: ${req.method} ${req.url}` } });
}

async function chatCompletion(body: any, req: http.IncomingMessage, res: http.ServerResponse) {
  const models = await listCopilotModels();
  const model = models.find((m) => m.id === body.model) ?? models.find((m) => m.family === body.model);
  if (!model) {
    return sendJson(res, 404, { error: { message: `GitHub Copilot has no model "${body.model}". Pick one in Settings → Model.` } });
  }

  const cts = new vscode.CancellationTokenSource();
  res.on('close', () => {
    if (!res.writableFinished) cts.cancel();
  });
  const messages = toLmMessages(body.messages ?? []);
  const tools = (body.tools ?? []).map((t: any) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    inputSchema: t.function.parameters,
  }));
  const response = await model.sendRequest(
    messages,
    {
      justification: 'WorkspaceGPT uses your GitHub Copilot models to answer and to run agent tasks.',
      tools: tools.length ? tools : undefined,
      toolMode: body.tool_choice === 'required' ? vscode.LanguageModelChatToolMode.Required : undefined,
    },
    cts.token
  );
  // vscode.lm reports no usage; the agent loop's context budget reads
  // prompt_tokens, so count with the model's own tokenizer alongside the request.
  const promptTokens = countPrompt(model, messages, tools.length ? JSON.stringify(tools) : '', cts.token);

  const id = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const write = (payload: object) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const chunk = (delta: object, finish_reason: string | null = null) =>
      write({ id, object: 'chat.completion.chunk', created, model: model.id, choices: [{ index: 0, delta, finish_reason }] });
    let text = '';
    let toolIndex = 0;
    try {
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
          chunk({ content: part.value });
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          chunk({ tool_calls: [{ index: toolIndex++, ...toOpenAiToolCall(part) }] });
        }
      }
      chunk({}, toolIndex ? 'tool_calls' : 'stop');
      const usage = await usageFor(model, promptTokens, text, cts.token);
      if (usage) write({ id, object: 'chat.completion.chunk', created, model: model.id, choices: [], usage });
      res.end('data: [DONE]\n\n');
    } catch (err) {
      // Headers are gone; the OpenAI SDK surfaces an in-stream error payload as an APIError.
      write({ error: { message: errorMessage(err) } });
      res.end();
    }
    return;
  }

  let content = '';
  const toolCalls: object[] = [];
  for await (const part of response.stream) {
    if (part instanceof vscode.LanguageModelTextPart) content += part.value;
    else if (part instanceof vscode.LanguageModelToolCallPart) toolCalls.push(toOpenAiToolCall(part));
  }
  const usage = await usageFor(model, promptTokens, content, cts.token);
  sendJson(res, 200, {
    id,
    object: 'chat.completion',
    created,
    model: model.id,
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
        message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      },
    ],
    ...(usage ? { usage } : {}),
  });
}

/**
 * OpenAI messages → vscode.lm messages. The stable API has only User and
 * Assistant roles, so system prompts ride as User messages; tool results are
 * User messages carrying a ToolResultPart keyed by the original call id.
 */
function toLmMessages(messages: any[]): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  for (const m of messages) {
    const text = textOf(m.content);
    if (m.role === 'assistant') {
      const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
      if (text) parts.push(new vscode.LanguageModelTextPart(text));
      for (const tc of m.tool_calls ?? []) {
        let input: object = {};
        try {
          input = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          // Malformed arguments from an earlier turn — send the call with no input rather than dropping it.
        }
        parts.push(new vscode.LanguageModelToolCallPart(tc.id, tc.function?.name ?? '', input));
      }
      if (parts.length) out.push(vscode.LanguageModelChatMessage.Assistant(parts));
    } else if (m.role === 'tool') {
      out.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(m.tool_call_id, [new vscode.LanguageModelTextPart(text)]),
        ])
      );
    } else if (text) {
      out.push(vscode.LanguageModelChatMessage.User(text));
    }
  }
  return out;
}

/** Text of an OpenAI content value; image parts are dropped (the worker retries text-only on its own). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p: any) => (p?.type === 'text' ? p.text ?? '' : '')).join('');
}

function toOpenAiToolCall(part: vscode.LanguageModelToolCallPart) {
  return { id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } };
}

async function countPrompt(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  toolSchemas: string,
  token: vscode.CancellationToken
): Promise<number | undefined> {
  try {
    const counts = await Promise.all([
      ...messages.map((m) => model.countTokens(m, token)),
      ...(toolSchemas ? [model.countTokens(toolSchemas, token)] : []),
    ]);
    return counts.reduce((a, b) => a + b, 0);
  } catch {
    return undefined;
  }
}

async function usageFor(
  model: vscode.LanguageModelChat,
  promptTokens: Promise<number | undefined>,
  completion: string,
  token: vscode.CancellationToken
) {
  const prompt = await promptTokens;
  if (prompt === undefined) return undefined;
  const completionTokens = completion ? await Promise.resolve(model.countTokens(completion, token)).catch(() => 0) : 0;
  return { prompt_tokens: prompt, completion_tokens: completionTokens, total_tokens: prompt + completionTokens };
}

function errorMessage(err: unknown): string {
  if (err instanceof vscode.LanguageModelError && err.code === vscode.LanguageModelError.NoPermissions().code) {
    return 'WorkspaceGPT is not allowed to use GitHub Copilot models. Allow it when VS Code asks, then retry.';
  }
  return err instanceof Error ? err.message : String(err);
}

function sendError(res: http.ServerResponse, err: unknown) {
  if (res.headersSent) return void res.end();
  let status = 500;
  if (err instanceof vscode.LanguageModelError) {
    if (err.code === vscode.LanguageModelError.NoPermissions().code) status = 403;
    else if (err.code === vscode.LanguageModelError.NotFound().code) status = 404;
    else if (err.code === vscode.LanguageModelError.Blocked().code) status = 429;
  } else if (err instanceof SyntaxError) {
    status = 400;
  }
  sendJson(res, status, { error: { message: errorMessage(err) } });
}

function sendJson(res: http.ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
