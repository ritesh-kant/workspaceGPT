/**
 * Atlassian Document Format ↔ plain text/markdown.
 *
 * Jira Cloud returns descriptions and comments as ADF — a JSON node tree —
 * not HTML, so adoWorkItemService.ts's `htmlToText` does not help here; this
 * is the genuinely net-new component docs/design/jira.md §5 P3 calls
 * out as the long pole on the critical path.
 *
 * `adfToText` deliberately matches `htmlToText`'s OUTPUT STYLE (plain text,
 * "• " bullets, blank-line paragraph breaks, styling marks dropped) rather
 * than emitting markdown: the two providers' prompt blocks should read the
 * same regardless of which tracker produced them, and htmlToText already set
 * that precedent. The one addition is links: ADO's HTML usually has the URL
 * as its own visible text (buildTicketLinks's URL_RE relies on that), but ADF
 * lets a link's visible text and href differ freely — so a link mark whose
 * text isn't already the URL gets the URL appended in parens, or that
 * reference is silently dropped from every ticket link the model is told to
 * open.
 *
 * `markdownToAdf` is the reverse, for `addComment` — it deliberately mirrors
 * shipHelpers.ts's `reportToHtml` subset exactly (headings, bullet lines,
 * pipe tables, inline `` `code` `` and `**bold**`, plain paragraphs): the
 * ship-report markdown that function renders to ADO's HTML is the same
 * markdown a Jira comment needs to render, so the two converters should
 * recognise identical input.
 */

interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

/** The shape Jira's REST API actually wants at the top level (`fields.description`, a comment body, …). */
export interface AdfDoc {
  type: 'doc';
  version: number;
  content: AdfNode[];
}

function inlineText(node: AdfNode): string {
  switch (node.type) {
    case 'text': {
      const text = node.text ?? '';
      const link = node.marks?.find((m) => m.type === 'link');
      const href = link?.attrs?.href as string | undefined;
      // Only append the href when the visible text doesn't already carry it —
      // an auto-linkified "https://..." would otherwise show its own URL twice.
      return href && !text.includes(href) ? `${text} (${href})` : text;
    }
    case 'hardBreak':
      return '\n';
    case 'mention':
      return `@${(node.attrs?.text as string) ?? (node.attrs?.id as string) ?? ''}`.replace(/^@@/, '@');
    case 'emoji':
      return (node.attrs?.text as string) ?? (node.attrs?.shortName as string) ?? '';
    case 'inlineCard':
    case 'blockCard':
      return (node.attrs?.url as string) ?? '';
    default:
      return (node.content ?? []).map(inlineText).join('');
  }
}

/** One table row, cells joined with " | " — enough fidelity for a prompt block; ADF's merged-cell attrs are ignored. */
function tableRowText(row: AdfNode): string {
  return (row.content ?? [])
    .map((cell) => (cell.content ?? []).map(inlineText).join(' ').trim())
    .join(' | ');
}

function blockLines(node: AdfNode, indent = ''): string[] {
  switch (node.type) {
    case 'doc':
      return (node.content ?? []).flatMap((n) => blockLines(n));
    case 'paragraph':
    case 'heading': {
      const text = (node.content ?? []).map(inlineText).join('');
      return [`${indent}${text}`];
    }
    case 'codeBlock':
      return [`${indent}${(node.content ?? []).map(inlineText).join('')}`];
    case 'blockquote':
      return (node.content ?? []).flatMap((n) => blockLines(n, indent));
    case 'panel': {
      const label = node.attrs?.panelType ? `[${String(node.attrs.panelType).toUpperCase()}] ` : '';
      const inner = (node.content ?? []).flatMap((n) => blockLines(n, indent));
      return inner.length ? [`${indent}${label}${inner[0].trimStart()}`, ...inner.slice(1)] : [];
    }
    case 'bulletList':
    case 'orderedList': {
      const lines: string[] = [];
      (node.content ?? []).forEach((item, i) => {
        const marker = node.type === 'orderedList' ? `${i + 1}. ` : '• ';
        const itemLines = (item.content ?? []).flatMap((n) => blockLines(n, `${indent}  `));
        if (!itemLines.length) return;
        lines.push(`${indent}${marker}${itemLines[0].trimStart()}`);
        lines.push(...itemLines.slice(1));
      });
      return lines;
    }
    case 'table':
      return (node.content ?? []).map((row) => `${indent}${tableRowText(row)}`);
    case 'rule':
      return ['---'];
    case 'mediaSingle':
    case 'mediaGroup':
      // Images are pulled out separately by mediaIdsFromAdf + a dedicated
      // attachment fetch (see jiraTicketProvider.ts) — nothing to render inline.
      return [];
    default:
      return node.content ? node.content.flatMap((n) => blockLines(n, indent)) : [];
  }
}

/** ADF description/comment body → plain text, matching htmlToText's output shape. */
export function adfToText(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  const lines = blockLines(doc as AdfNode).filter((l, i, arr) => !(l === '' && arr[i - 1] === ''));
  return lines.join('\n\n').trim();
}

/**
 * File-type media node ids referenced anywhere in the doc (mediaSingle and
 * mediaGroup alike). 'external' media (attrs.url pointing off-Atlassian) is
 * deliberately excluded — same reasoning as adoWorkItemService.ts's
 * extractImageUrls only trusting ADO's own attachment hosts: blindly fetching
 * an arbitrary external URL would leak the site's auth header to it, and an
 * 'external' media node's url is never one that needs this header anyway.
 */
export function mediaIdsFromAdf(doc: unknown): string[] {
  const ids: string[] = [];
  const walk = (node: AdfNode | undefined): void => {
    if (!node) return;
    if (node.type === 'media' && node.attrs?.type === 'file' && typeof node.attrs.id === 'string') {
      ids.push(node.attrs.id);
    }
    (node.content ?? []).forEach(walk);
  };
  walk(doc as AdfNode);
  return ids;
}

const ADF_VERSION = 1;

function textNode(text: string, marks?: AdfMark[]): AdfNode {
  return marks?.length ? { type: 'text', text, marks } : { type: 'text', text };
}

/** Inline `` `code` `` and `**bold**` — the same two marks reportToHtml recognises. */
function inlineNodes(raw: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    if (m.index > last) nodes.push(textNode(raw.slice(last, m.index)));
    if (m[1] !== undefined) nodes.push(textNode(m[1], [{ type: 'code' }]));
    else nodes.push(textNode(m[2], [{ type: 'strong' }]));
    last = m.index + m[0].length;
  }
  if (last < raw.length) nodes.push(textNode(raw.slice(last)));
  return nodes.length ? nodes : [textNode(raw)];
}

/** Markdown → ADF, mirroring reportToHtml's exact subset (see file doc comment). */
export function markdownToAdf(markdown: string): AdfDoc {
  const content: AdfNode[] = [];
  let listItems: AdfNode[] = [];
  let tableRows: string[] = [];

  const flushList = () => {
    if (!listItems.length) return;
    content.push({ type: 'bulletList', content: listItems });
    listItems = [];
  };
  const flushTable = () => {
    if (!tableRows.length) return;
    const rows = tableRows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
    content.push({
      type: 'table',
      content: rows.map((r) => ({
        type: 'tableRow',
        content: r
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((cell) => ({
            type: 'tableCell',
            content: [{ type: 'paragraph', content: inlineNodes(cell.trim()) }],
          })),
      })),
    });
    tableRows = [];
  };

  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*\|/.test(line)) {
      flushList();
      tableRows.push(line);
      continue;
    }
    flushTable();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      content.push({ type: 'heading', attrs: { level: Math.min(h[1].length, 6) }, content: inlineNodes(h[2]) });
    } else if (/^\s*[-*]\s+/.test(line)) {
      listItems.push({
        type: 'listItem',
        content: [{ type: 'paragraph', content: inlineNodes(line.replace(/^\s*[-*]\s+/, '')) }],
      });
    } else {
      flushList();
      if (line.trim()) content.push({ type: 'paragraph', content: inlineNodes(line) });
    }
  }
  flushList();
  flushTable();

  return { type: 'doc', version: ADF_VERSION, content };
}
