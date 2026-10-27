/**
 * Chat Completions ⇄ Responses, for Copilot models served only on /responses
 * (the newest GPT models). Every WorkspaceGPT caller speaks Chat Completions
 * to the loopback bridge; copilotDirect.ts uses this module to send such a
 * model's request to /responses and hand the answer back in the shape the
 * caller asked for, streamed or not. Pure functions, no `vscode`.
 *
 * Reasoning: a reasoning model's thinking comes back as encrypted `reasoning`
 * items. Chat Completions has nowhere to carry them, so they are kept here,
 * keyed by the tool call they led to, and put back in front of that call on
 * the next round of the run; without them the model starts its thinking over
 * after every tool result.
 */

/** Encrypted reasoning items, keyed by the call_id of the first tool call they preceded. */
const reasoningByCall = new Map<string, any[]>();
const MAX_REMEMBERED_CALLS = 500;

/** The optional parts of a request a stricter endpoint may refuse; see `withoutExtras`. */
const INCLUDE_REASONING = ['reasoning.encrypted_content'];

/** A Chat Completions request body → a Responses request body. */
export function chatToResponsesRequest(body: any): any {
  const input: any[] = [];
  for (const m of body.messages ?? []) {
    if (m?.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: textOf(m.content) });
      continue;
    }
    if (m?.role === 'assistant') {
      const text = textOf(m.content);
      if (text) input.push({ role: 'assistant', content: text });
      for (const [i, tc] of (m.tool_calls ?? []).entries()) {
        if (i === 0) input.push(...(reasoningByCall.get(tc.id) ?? []));
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? '' });
      }
      continue;
    }
    const role = m?.role === 'system' || m?.role === 'developer' ? 'developer' : 'user';
    input.push({ role, content: typeof m?.content === 'string' ? m.content : inputParts(m?.content) });
  }

  const out: any = { model: body.model, input, store: false, stream: !!body.stream };
  const tools = (body.tools ?? []).filter((t: any) => t?.type === 'function' && t.function?.name);
  if (tools.length) {
    out.tools = tools.map((t: any) => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters ?? { type: 'object', properties: {} },
      strict: false,
    }));
    const choice = body.tool_choice;
    if (choice !== undefined) out.tool_choice = typeof choice === 'string' ? choice : { type: 'function', name: choice?.function?.name };
    if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  // The Responses API's floor for max_output_tokens is 16.
  if (typeof maxTokens === 'number') out.max_output_tokens = Math.max(16, maxTokens);
  if (body.reasoning_effort) out.reasoning = { effort: body.reasoning_effort };
  // Reasoning models refuse sampling parameters, so temperature/top_p are not carried.
  out.include = INCLUDE_REASONING;
  if (body.prompt_cache_key) out.prompt_cache_key = body.prompt_cache_key;
  return out;
}

/** The same request without the parts an endpoint might refuse: carried reasoning and its include. */
export function withoutExtras(req: any): any {
  const { include: _include, ...rest } = req;
  return { ...rest, input: req.input.filter((i: any) => i?.type !== 'reasoning') };
}

/** True when `req` has anything `withoutExtras` would drop. */
export function hasExtras(req: any): boolean {
  return !!req.include || req.input.some((i: any) => i?.type === 'reasoning');
}

/** A finished Responses object → a Chat Completions response. */
export function responsesToChatCompletion(resp: any, model: string): any {
  rememberReasoning(resp.output);
  const text = (resp.output ?? [])
    .filter((o: any) => o?.type === 'message')
    .flatMap((o: any) => o.content ?? [])
    .filter((c: any) => c?.type === 'output_text')
    .map((c: any) => c.text)
    .join('');
  const calls = (resp.output ?? []).filter((o: any) => o?.type === 'function_call');
  const summary = reasoningSummary(resp.output);
  const message: any = { role: 'assistant', content: text || null };
  if (calls.length) {
    message.tool_calls = calls.map((c: any) => ({ id: c.call_id, type: 'function', function: { name: c.name, arguments: c.arguments ?? '' } }));
  }
  if (summary) message.reasoning_content = summary;
  return {
    id: resp.id,
    object: 'chat.completion',
    created: resp.created_at ?? Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason(resp, calls.length > 0) }],
    usage: chatUsage(resp.usage),
  };
}

/**
 * Turns a Responses event stream into Chat Completions chunks. Feed it the
 * upstream bytes; it returns the SSE text to write to the caller.
 */
export class ResponsesStreamTranslator {
  private buffer = '';
  private created = Math.floor(Date.now() / 1000);
  private id = `chatcmpl-${Date.now()}`;
  /** output_index of each function_call → its index among this answer's tool calls. */
  private toolIndex = new Map<number, number>();
  /** Arguments already sent per output_index, for a call whose done event carries more. */
  private sentArgs = new Map<number, string>();
  private done = false;

  constructor(private model: string, private includeUsage: boolean) {}

  push(bytes: string): string {
    this.buffer += bytes;
    let out = '';
    let cut: number;
    while ((cut = this.buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      out += this.handle(event);
    }
    return out;
  }

  /** Whatever the stream still owes when upstream ends: a stream cut short ends with an error the caller sees. */
  end(): string {
    const tail = this.buffer.trim() ? this.push('\n\n') : '';
    if (this.done) return tail;
    this.done = true;
    return tail + sse({ error: { message: 'GitHub Copilot ended the response before it finished.' } });
  }

  private handle(e: any): string {
    switch (e?.type) {
      case 'response.created':
        if (e.response?.id) this.id = e.response.id;
        return this.chunk({ role: 'assistant', content: '' });
      case 'response.output_text.delta':
        return e.delta ? this.chunk({ content: e.delta }) : '';
      case 'response.reasoning_summary_text.delta':
        return e.delta ? this.chunk({ reasoning_content: e.delta }) : '';
      case 'response.output_item.added': {
        if (e.item?.type !== 'function_call') return '';
        const index = this.toolIndex.size;
        this.toolIndex.set(e.output_index, index);
        const args = e.item.arguments ?? '';
        this.sentArgs.set(e.output_index, args);
        return this.chunk({ tool_calls: [{ index, id: e.item.call_id, type: 'function', function: { name: e.item.name, arguments: args } }] });
      }
      case 'response.function_call_arguments.delta': {
        const index = this.toolIndex.get(e.output_index);
        if (index === undefined || !e.delta) return '';
        this.sentArgs.set(e.output_index, (this.sentArgs.get(e.output_index) ?? '') + e.delta);
        return this.chunk({ tool_calls: [{ index, function: { arguments: e.delta } }] });
      }
      case 'response.output_item.done': {
        // A call whose arguments arrived whole, with no delta events.
        const index = this.toolIndex.get(e.output_index);
        const full = e.item?.type === 'function_call' ? e.item.arguments ?? '' : '';
        const sent = this.sentArgs.get(e.output_index) ?? '';
        if (index === undefined || full.length <= sent.length || !full.startsWith(sent)) return '';
        this.sentArgs.set(e.output_index, full);
        return this.chunk({ tool_calls: [{ index, function: { arguments: full.slice(sent.length) } }] });
      }
      case 'response.completed':
      case 'response.incomplete': {
        this.done = true;
        const resp = e.response ?? {};
        rememberReasoning(resp.output);
        let out = this.chunk({}, finishReason(resp, this.toolIndex.size > 0));
        if (this.includeUsage && resp.usage) out += sse({ ...this.base(), choices: [], usage: chatUsage(resp.usage) });
        return out + 'data: [DONE]\n\n';
      }
      case 'response.failed':
      case 'error': {
        this.done = true;
        const err = e.response?.error ?? e.error ?? e;
        return sse({ error: { message: err?.message ?? 'GitHub Copilot could not finish the response.', code: err?.code } });
      }
      default:
        return '';
    }
  }

  private base() {
    return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model };
  }

  private chunk(delta: any, finish: string | null = null): string {
    return sse({ ...this.base(), choices: [{ index: 0, delta, finish_reason: finish }] });
  }
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
}

function inputParts(content: any): any[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((p: any) => {
      if (p?.type === 'text') return { type: 'input_text', text: p.text ?? '' };
      if (p?.type === 'image_url') {
        const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
        return url ? { type: 'input_image', image_url: url, detail: p.image_url?.detail ?? 'auto' } : undefined;
      }
      return undefined;
    })
    .filter(Boolean);
}

function finishReason(resp: any, hasCalls: boolean): string {
  if (resp?.status === 'incomplete') return resp.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length';
  return hasCalls ? 'tool_calls' : 'stop';
}

function chatUsage(u: any): any {
  if (!u) return undefined;
  return {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0 },
  };
}

function reasoningSummary(output: any[] | undefined): string {
  return (output ?? [])
    .filter((o: any) => o?.type === 'reasoning')
    .flatMap((o: any) => o.summary ?? [])
    .map((s: any) => s?.text ?? '')
    .filter(Boolean)
    .join('\n\n');
}

/** Keeps each run of encrypted reasoning items under the first tool call that follows it. */
function rememberReasoning(output: any[] | undefined): void {
  let pending: any[] = [];
  for (const item of output ?? []) {
    if (item?.type === 'reasoning' && item.encrypted_content) {
      pending.push({ type: 'reasoning', id: item.id, summary: item.summary ?? [], encrypted_content: item.encrypted_content });
    } else if (item?.type === 'function_call' && pending.length) {
      reasoningByCall.set(item.call_id, pending);
      pending = [];
    }
  }
  while (reasoningByCall.size > MAX_REMEMBERED_CALLS) reasoningByCall.delete(reasoningByCall.keys().next().value!);
}
