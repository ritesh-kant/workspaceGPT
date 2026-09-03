import type { WebSearchResultItem } from './webSearchTool';

const DDG_HTML_URL = 'https://duckduckgo.com/html/';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_SNIPPET_CHARS = 800;
// A realistic desktop browser UA — DDG's non-JS /html/ endpoint is built for
// exactly this kind of client, unlike Google's SERP which actively resists
// non-browser fetches.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Extracts `{title, url, snippet}` results out of DuckDuckGo's `/html/`
 * results page. Targeted regex against DDG's stable legacy markup
 * (`result__a` / `result__snippet`) rather than a full HTML parser — this
 * repo has zero HTML-parsing dependencies today, and this path is a fallback
 * most users (anyone with a Tavily key) never hit, so it doesn't justify the
 * bundle/activation cost of adding one. Isolated here so it's easy to swap
 * out if DDG's markup ever shifts.
 */
function parseResults(html: string, maxResults: number): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = [];
  const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const decode = (s: string) =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

  let match: RegExpExecArray | null;
  while (results.length < maxResults && (match = blockRe.exec(html))) {
    const url = decode(match[1]);
    const title = decode(match[2]);
    const snippetRaw = decode(match[3]);
    if (!url || !title) continue;
    results.push({
      title,
      url,
      snippet:
        snippetRaw.length > MAX_SNIPPET_CHARS
          ? `${snippetRaw.slice(0, MAX_SNIPPET_CHARS)}… (truncated)`
          : snippetRaw,
    });
  }
  return results;
}

/**
 * No-key fallback for `search_web`: scrapes DuckDuckGo's non-JS `/html/`
 * results page. Never throws — any failure (network, timeout, unparseable
 * markup, zero results) degrades to an empty list so the agent's turn
 * continues with "no results" rather than erroring out.
 */
export async function searchDuckDuckGo(query: string, maxResults: number): Promise<WebSearchResultItem[]> {
  try {
    const url = `${DDG_HTML_URL}?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const html = await response.text();
    return parseResults(html, maxResults);
  } catch (e) {
    console.warn('DuckDuckGo basic search failed (continuing with no results):', e);
    return [];
  }
}
