import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../constants';
import { withKeyFailover } from '../utils/apiKeyFailover';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const MAX_SNIPPET_CHARS = 800;

export interface WebSearchArgs {
  query: string;
  maxResults?: number;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  /** Tavily's own synthesized answer, when available — read this first. */
  answer?: string;
  results: WebSearchResultItem[];
}

/** All configured Tavily keys (falls back to the legacy single-key field). */
function getApiKeys(context: vscode.ExtensionContext): string[] {
  const settings: any = context.globalState.get(STORAGE_KEYS.SETTINGS);
  const webSearch = settings?.state?.config?.webSearch;
  const keys: string[] =
    webSearch?.apiKeys && webSearch.apiKeys.length > 0
      ? webSearch.apiKeys
      : webSearch?.apiKey
        ? [webSearch.apiKey]
        : [];
  return keys.map((k) => (k ?? '').trim()).filter((k) => k.length > 0);
}

async function tavilySearch(apiKey: string, query: string, maxResults: number): Promise<any> {
  const response = await fetch(TAVILY_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      include_answer: true,
    }),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Tavily rejected the API key — check it in Settings → Web Search.');
    }
    if (response.status === 429) {
      const err: any = new Error(
        'Tavily rate limit hit — the free-tier monthly quota is likely exhausted for this key.'
      );
      err.status = 429;
      throw err;
    }
    const body = await response.text().catch(() => '');
    throw new Error(`Web search failed (${response.status}): ${body.slice(0, 200)}`);
  }

  return response.json();
}

/**
 * Live web search (Tavily) — the one tool that can bridge a gap no org doc or
 * codebase search can: a library/API/product the model has never seen, or
 * anything that has changed since its training cutoff.
 *
 * Multiple keys configured in Settings → Web Search are tried in order, the
 * same failover-on-429 contract as the Model/Embedding providers (see
 * apiKeyFailover.ts) — useful for spreading Tavily's free-tier quota across
 * several keys.
 */
export async function searchWeb(
  context: vscode.ExtensionContext,
  args: WebSearchArgs,
  onKeyRotate?: (message: string) => void
): Promise<WebSearchResult> {
  const query = (args?.query ?? '').trim();
  if (!query) throw new Error('query must be non-empty.');
  const apiKeys = getApiKeys(context);
  if (!apiKeys.length) {
    throw new Error(
      'Web search is not configured — add a free Tavily API key in Settings → Web Search ' +
        '(tavily.com, no card required). Answer from other tools/knowledge, or tell the user this needs setup.'
    );
  }
  const maxResults = Math.min(Math.max(args?.maxResults ?? 5, 1), 10);

  const data: any = await withKeyFailover(
    apiKeys,
    (apiKey) => tavilySearch(apiKey, query, maxResults),
    onKeyRotate
  );
  const results: WebSearchResultItem[] = (data?.results ?? [])
    .slice(0, maxResults)
    .map((r: any) => ({
      title: r?.title ?? '',
      url: r?.url ?? '',
      snippet:
        typeof r?.content === 'string'
          ? r.content.length > MAX_SNIPPET_CHARS
            ? `${r.content.slice(0, MAX_SNIPPET_CHARS)}… (truncated)`
            : r.content
          : '',
    }));

  return {
    answer: typeof data?.answer === 'string' && data.answer.trim() ? data.answer : undefined,
    results,
  };
}
