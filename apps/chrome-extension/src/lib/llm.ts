export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmProxyConfig {
  proxyUrl: string;
  accessToken: string;
  model: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Stream an OpenAI-compatible chat completion, yielding content deltas. */
export async function* streamChat(
  cfg: LlmConfig | LlmProxyConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const isProxy = 'proxyUrl' in cfg;
  const url = isProxy
    ? `${cfg.proxyUrl.replace(/\/+$/, '')}/api/llm-chat`
    : `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const authHeader = isProxy ? `Bearer ${cfg.accessToken}` : `Bearer ${cfg.apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({ model: cfg.model, messages, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LLM request failed: ${res.status} ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // partial JSON across chunk boundary — ignore
      }
    }
  }
}
