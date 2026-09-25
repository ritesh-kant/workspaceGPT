/**
 * Confluence page body (ADF) ↔ markdown, and section-level edits on the ADF.
 *
 * Why ADF and not storage XHTML: ADF is a JSON tree, so an edit can replace
 * the nodes of ONE section and hand every other node back to Confluence
 * untouched — macros, mentions, images and layouts included. A whole-page
 * markdown round trip would silently destroy all of those.
 *
 * What markdown cannot express survives as a KEEP TOKEN, `⟦keep 3: jira⟧`:
 * the model sees a readable placeholder, and a token copied into its edit is
 * swapped back for the original node, byte for byte. Deleting a token deletes
 * that element — the review diff shows it either way.
 *
 * Panels and expands are containers people write prose in, so they render as
 * `:::panel info` … `:::` fences (readable, editable) rather than tokens.
 * Layout columns are transparent: their content renders in order, and their
 * headings are sections like any other.
 *
 * markdown → ADF is a markdown-it token mapper. Measured 2026-09-25 against
 * all 3,420 pages of a real space with @atlaskit/adf-utils' validator: 3420
 * valid, 0 markdown syntax leaked into text, vs 3416 (+3,332 raw table rows
 * leaked) for @atlaskit/editor-markdown-transformer at ~190x the bundle, and
 * 2777 for marklassian. markdown-it is already a host dependency.
 *
 * Pure — no vscode import — so the headless unit tests load it directly.
 */
import MarkdownIt from 'markdown-it';

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

export interface AdfDoc {
  type: 'doc';
  version: number;
  content: AdfNode[];
}

/** Elements rendered as keep tokens, by the id the token carries. */
export type KeepMap = Map<number, AdfNode>;

const KEEP_RE = /⟦keep (\d+)(?::[^⟧\n]*)?⟧/g;

// ─────────────────────────── ADF → markdown ───────────────────────────

const INLINE_KEEP = new Set(['mention', 'emoji', 'date', 'status', 'inlineCard', 'inlineExtension', 'mediaInline', 'placeholder']);
/** Containers whose content renders in place, and whose headings are sections. */
const TRANSPARENT = new Set(['layoutSection', 'layoutColumn']);

function plainText(node: AdfNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return ' ';
  if (node.type === 'mention') return String(node.attrs?.text ?? '');
  if (node.type === 'status') return String(node.attrs?.text ?? '');
  return (node.content ?? []).map(plainText).join('');
}

function keepLabel(node: AdfNode): string {
  const a = node.attrs ?? {};
  let label: string;
  switch (node.type) {
    case 'mention': label = String(a.text ?? '@mention'); break;
    case 'emoji': label = String(a.text ?? a.shortName ?? 'emoji'); break;
    case 'status': label = `status ${a.text ?? ''}`; break;
    case 'date': label = `date ${a.timestamp ? new Date(Number(a.timestamp)).toISOString().slice(0, 10) : ''}`; break;
    case 'inlineCard': case 'blockCard': case 'embedCard': label = `link ${a.url ?? ''}`; break;
    case 'extension': case 'bodiedExtension': case 'inlineExtension':
      label = `${a.extensionKey ?? 'macro'} macro`;
      break;
    case 'mediaSingle': case 'mediaGroup': case 'mediaInline': label = 'image/attachment'; break;
    case 'table': label = `table: ${plainText(node).slice(0, 60)}`; break;
    default: label = node.type;
  }
  const text = node.type === 'bodiedExtension' || node.type === 'decisionList' ? plainText(node).trim().slice(0, 80) : '';
  return (text ? `${label} — ${text}` : label).replace(/[⟦⟧\n]/g, ' ').trim();
}

/** `**x**`-safe text: escape what markdown-it would otherwise read as syntax. */
function escapeText(s: string): string {
  const alnum = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c);
  return s
    .replace(/([\\`*[\]~])/g, '\\$1')
    .replace(/&(?=#?\w+;)/g, '\\&')
    // snake_case stays readable; an underscore that could open/close emphasis is escaped.
    .replace(/_/g, (m, off: number, str: string) => (alnum(str[off - 1]) && alnum(str[off + 1]) ? m : '\\_'));
}

/** Escape what would start a block construct at the head of a line. */
function escapeLineStart(line: string): string {
  return line.replace(/^(\s*)(#{1,6}\s|>|[-+]\s|\d+[.)]\s|\||:::)/, (_m, sp, tok) => `${sp}\\${tok}`);
}

class Renderer {
  private ids = new Map<AdfNode, number>();
  private next = 1;
  constructor(readonly keep: KeepMap) {}

  /** Assign token ids in document order, once, over the whole doc — ids stay stable across every slice rendered. */
  index(nodes: AdfNode[]): void {
    const walk = (n: AdfNode) => {
      if (this.isKeep(n)) {
        if (!this.ids.has(n)) {
          const id = this.next++;
          this.ids.set(n, id);
          this.keep.set(id, n);
        }
        return;
      }
      (n.content ?? []).forEach(walk);
    };
    nodes.forEach(walk);
  }

  private isKeep(n: AdfNode): boolean {
    if (INLINE_KEEP.has(n.type)) return true;
    if (n.type === 'table') return !isSimpleTable(n);
    return !BLOCK_RENDERED.has(n.type) && !INLINE_RENDERED.has(n.type) && !TRANSPARENT.has(n.type);
  }

  token(n: AdfNode): string {
    let id = this.ids.get(n);
    if (id === undefined) {
      id = this.next++;
      this.ids.set(n, id);
      this.keep.set(id, n);
    }
    return `⟦keep ${id}: ${keepLabel(n)}⟧`;
  }

  /**
   * Inline content with marks rendered as RUNS: a mark opens where the first
   * node carrying it starts and closes where the last one ends. Wrapping each
   * text node on its own turns `*a*` + `*b*` into `*a**b*`, which parses back
   * as something else. Whitespace stays outside delimiters — `**foo **` is not
   * a closing delimiter in CommonMark.
   */
  inline(nodes: AdfNode[] = []): string {
    const ORDER = ['link', 'strong', 'em', 'strike'];
    const OPEN: Record<string, string> = { strong: '**', em: '*', strike: '~~', link: '[' };
    const key = (m: AdfMark) => (m.type === 'link' ? `link ${String(m.attrs?.href ?? '')}` : m.type);
    const close = (k: string) => (k.startsWith('link ') ? `](${k.slice(5)})` : OPEN[k]);
    const open = (k: string) => (k.startsWith('link ') ? '[' : OPEN[k]);
    let out = '';
    let stack: string[] = [];
    let pendingWs = '';
    const moveTo = (want: string[]) => {
      let common = 0;
      while (common < stack.length && common < want.length && stack[common] === want[common]) common++;
      for (let i = stack.length - 1; i >= common; i--) out += close(stack[i]);
      out += pendingWs;
      pendingWs = '';
      for (let i = common; i < want.length; i++) out += open(want[i]);
      stack = want.slice();
    };
    for (const n of nodes) {
      if (n.type !== 'text') {
        moveTo([]);
        out += n.type === 'hardBreak' ? '\\\n' : this.token(n);
        continue;
      }
      const raw = n.text ?? '';
      const marks = n.marks ?? [];
      const link = marks.find((m) => m.type === 'link');
      const href = String(link?.attrs?.href ?? '');
      // A bare self-link with no other marks round-trips as an autolink.
      if (link && raw === href && marks.length === 1) {
        moveTo([]);
        out += `<${href}>`;
        continue;
      }
      const isCode = marks.some((m) => m.type === 'code');
      // Code spans are not flanking-sensitive, and their spaces are content.
      const lead = isCode ? '' : /^\s*/.exec(raw)![0];
      const trail = isCode ? '' : raw.slice(lead.length).match(/\s*$/)![0];
      const core = raw.slice(lead.length, raw.length - trail.length);
      if (!core) {
        pendingWs += raw;
        continue;
      }
      const want = marks.filter((m) => ORDER.includes(m.type)).sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type)).map(key);
      pendingWs += lead;
      moveTo(want);
      if (isCode) {
        const fence = '`'.repeat(Math.max(0, ...(core.match(/`+/g) ?? []).map((r) => r.length)) + 1);
        // CommonMark strips one space from each end when both ends have one.
        const pad = /^[` ]|[` ]$/.test(core) && (/^`|`$/.test(core) || (/^ /.test(core) && / $/.test(core) && !!core.trim())) ? ' ' : '';
        out += `${fence}${pad}${core}${pad}${fence}`;
      } else {
        out += escapeText(core);
      }
      pendingWs = trail;
    }
    moveTo([]);
    return out;
  }

  blocks(nodes: AdfNode[] = []): string[] {
    const out: string[] = [];
    let prev: AdfNode | undefined;
    let alt = false;
    for (const n of nodes) {
      // Two adjacent lists of one kind would merge into one; a different
      // bullet/delimiter character starts a new list in CommonMark.
      alt = prev?.type === n.type && (n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'taskList') ? !alt : false;
      prev = n;
      const lines = this.block(n, alt);
      if (!lines.length) continue;
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(...lines);
    }
    return out;
  }

  private block(n: AdfNode, alt = false): string[] {
    switch (n.type) {
      case 'paragraph':
        return this.inline(n.content).split('\n').map(escapeLineStart);
      case 'heading':
        return [`${'#'.repeat(Number(n.attrs?.level ?? 1))} ${this.inline(n.content)}`];
      case 'codeBlock': {
        const lang = String(n.attrs?.language ?? '');
        const text = (n.content ?? []).map((c) => c.text ?? '').join('');
        const fence = '`'.repeat(Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length)) + 1);
        return [`${fence}${lang}`, ...text.split('\n'), fence];
      }
      case 'rule':
        return ['---'];
      case 'blockquote':
        return this.blocks(n.content).map((l) => (l ? `> ${l}` : '>'));
      case 'bulletList':
      case 'orderedList': {
        const start = Number(n.attrs?.order ?? 1);
        return (n.content ?? []).flatMap((item, i) => {
          const marker = n.type === 'orderedList' ? `${start + i}${alt ? ')' : '.'} ` : alt ? '* ' : '- ';
          return this.indented(marker, this.blocks(item.content).filter((l, j, a) => l !== '' || (a[j + 1] ?? '').trim() !== ''));
        });
      }
      case 'taskList':
        return (n.content ?? []).flatMap((item) =>
          item.type === 'taskItem'
            ? this.indented(`${alt ? '*' : '-'} [${item.attrs?.state === 'DONE' ? 'x' : ' '}] `, this.inline(item.content).split('\n'))
            : [this.token(item)]
        );
      case 'table':
        return isSimpleTable(n) ? this.table(n) : [this.token(n)];
      case 'panel':
        return [`:::panel ${n.attrs?.panelType ?? 'info'}`, ...this.blocks(n.content), ':::'];
      case 'expand':
      case 'nestedExpand':
        return [`:::expand ${String(n.attrs?.title ?? '').replace(/\n/g, ' ')}`.trimEnd(), ...this.blocks(n.content), ':::'];
      case 'layoutSection':
      case 'layoutColumn':
        return this.blocks(n.content);
      default:
        return [this.token(n)];
    }
  }

  private indented(marker: string, lines: string[]): string[] {
    const pad = ' '.repeat(marker.length);
    return lines.map((l, i) => (i === 0 ? marker + l : l ? pad + l : ''));
  }

  private table(n: AdfNode): string[] {
    const rows = (n.content ?? []).map((row) =>
      (row.content ?? []).map((cell) => this.inline(cell.content?.[0]?.content).replace(/\|/g, '\\|'))
    );
    const width = Math.max(...rows.map((r) => r.length));
    const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
    return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)];
  }
}

const BLOCK_RENDERED = new Set(['paragraph', 'heading', 'codeBlock', 'rule', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'table', 'tableRow', 'tableCell', 'tableHeader', 'panel', 'expand', 'nestedExpand']);
const INLINE_RENDERED = new Set(['text', 'hardBreak']);

/**
 * A table markdown can carry without loss: header row then body rows, no
 * merged cells, each cell one paragraph of plain inline content. Anything
 * else is kept whole as a token rather than flattened.
 */
function isSimpleTable(t: AdfNode): boolean {
  const rows = t.content ?? [];
  if (!rows.length) return false;
  return rows.every((row, r) =>
    (row.content ?? []).length > 0 &&
    (row.content ?? []).every((cell) => {
      if (cell.type !== (r === 0 ? 'tableHeader' : 'tableCell')) return false;
      if (Number(cell.attrs?.colspan ?? 1) !== 1 || Number(cell.attrs?.rowspan ?? 1) !== 1) return false;
      const c = cell.content ?? [];
      if (c.length > 1 || (c[0] && c[0].type !== 'paragraph')) return false;
      return (c[0]?.content ?? []).every((x) => x.type === 'text' || INLINE_KEEP.has(x.type));
    })
  );
}

export interface RenderedPage {
  markdown: string;
  keep: KeepMap;
  /** Headings an edit can target, in page order, as `## Title`. */
  sections: string[];
}

/** A page body as markdown the model can read and edit, with the keep map an edit needs. */
export function adfToMarkdown(doc: AdfDoc | null | undefined): RenderedPage {
  const keep: KeepMap = new Map();
  if (!doc?.content) return { markdown: '', keep, sections: [] };
  const r = new Renderer(keep);
  r.index(doc.content);
  const sections = sectionLabels(allSections(doc));
  return { markdown: r.blocks(doc.content).join('\n').trim(), keep, sections };
}

// ─────────────────────────── markdown → ADF ───────────────────────────

// linkify off: fuzzy auto-linking turned plain "www.brand.com" and emails into
// links on every round trip. Links are explicit ([text](url) or <url>).
const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

const LIST_ITEM_OK = new Set(['paragraph', 'bulletList', 'orderedList', 'codeBlock', 'mediaSingle', 'taskList', 'extension']);
const QUOTE_OK = new Set(['paragraph', 'bulletList', 'orderedList', 'codeBlock', 'mediaGroup', 'mediaSingle']);
const PANEL_OK = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'codeBlock', 'rule', 'mediaGroup', 'mediaSingle', 'taskList', 'decisionList', 'blockCard', 'extension']);
const EXPAND_BLOCKED = new Set(['expand', 'layoutSection']);
const CELL_OK = new Set(['paragraph', 'bulletList', 'orderedList', 'codeBlock', 'heading', 'panel', 'rule', 'blockquote', 'taskList', 'mediaSingle', 'mediaGroup', 'decisionList', 'nestedExpand', 'extension']);

class Builder {
  private seq = 0;
  constructor(private readonly keep: KeepMap) {}

  private localId(): string {
    return `wgpt-${Date.now().toString(36)}-${++this.seq}`;
  }

  private restore(id: string): AdfNode {
    const node = this.keep.get(Number(id));
    if (!node) {
      throw new Error(
        `⟦keep ${id}⟧ does not refer to any element of this page. Copy keep tokens exactly as the page showed them, or leave them out.`
      );
    }
    return node;
  }

  inline(tokens: any[]): AdfNode[] {
    const out: AdfNode[] = [];
    const marks: AdfMark[] = [];
    const push = (text: string, extra: AdfMark[] = []) => {
      if (!text) return;
      // Keep tokens inside text become the original inline nodes again.
      let last = 0;
      for (const m of text.matchAll(KEEP_RE)) {
        if (m.index! > last) this.pushText(out, text.slice(last, m.index), [...marks, ...extra]);
        out.push(this.restore(m[1]));
        last = m.index! + m[0].length;
      }
      if (last < text.length) this.pushText(out, text.slice(last), [...marks, ...extra]);
    };
    const pop = (type: string) => {
      const i = marks.map((m) => m.type).lastIndexOf(type);
      if (i >= 0) marks.splice(i, 1);
    };
    for (const t of tokens ?? []) {
      switch (t.type) {
        case 'text': push(t.content); break;
        case 'code_inline': this.pushText(out, t.content, [...marks, { type: 'code' }]); break;
        case 'softbreak': push(' '); break;
        case 'hardbreak': out.push({ type: 'hardBreak' }); break;
        case 'strong_open': marks.push({ type: 'strong' }); break;
        case 'strong_close': pop('strong'); break;
        case 'em_open': marks.push({ type: 'em' }); break;
        case 'em_close': pop('em'); break;
        case 's_open': marks.push({ type: 'strike' }); break;
        case 's_close': pop('strike'); break;
        case 'link_open': {
          const href = String(t.attrGet('href') ?? '');
          // ADF rejects relative hrefs ("../src/x.ts"): keep the text, drop the mark.
          marks.push(/^(https?:|mailto:|#)/i.test(href) ? { type: 'link', attrs: { href } } : { type: '_nolink' });
          break;
        }
        case 'link_close': pop(marks[marks.length - 1]?.type === '_nolink' ? '_nolink' : 'link'); break;
        case 'image': this.pushText(out, t.content || t.attrGet('src'), [...marks, { type: 'link', attrs: { href: t.attrGet('src') } }]); break;
        default: if (t.content) push(t.content);
      }
    }
    return out;
  }

  private pushText(out: AdfNode[], text: string, marks: AdfMark[]): void {
    if (!text) return;
    let m = marks.filter((x) => x.type !== '_nolink');
    // `code` combines only with `link` in ADF.
    if (m.some((x) => x.type === 'code')) m = m.filter((x) => x.type === 'code' || x.type === 'link');
    const prev = out[out.length - 1];
    const same = prev?.type === 'text' && JSON.stringify(prev.marks ?? []) === JSON.stringify(m);
    if (same) prev.text += text;
    else out.push(m.length ? { type: 'text', text, marks: m.map((x) => ({ ...x })) } : { type: 'text', text });
  }

  /** A paragraph; one holding a lone block keep token becomes that block again. */
  paragraph(content: AdfNode[]): AdfNode[] {
    const isBlock = (n: AdfNode) => n.type !== 'text' && n.type !== 'hardBreak' && !INLINE_KEEP.has(n.type);
    if (!content.some(isBlock)) return [content.length ? { type: 'paragraph', content } : { type: 'paragraph' }];
    const out: AdfNode[] = [];
    let run: AdfNode[] = [];
    const flush = () => {
      const trimmed = run.filter((n) => !(n.type === 'text' && !n.text!.trim()));
      if (trimmed.length) out.push({ type: 'paragraph', content: run });
      run = [];
    };
    for (const n of content) {
      if (isBlock(n)) { flush(); out.push(n); } else run.push(n);
    }
    flush();
    return out;
  }

  /** Force blocks into what a parent accepts: degrade rather than produce a doc Confluence rejects. */
  fit(nodes: AdfNode[], allowed: Set<string>): AdfNode[] {
    return nodes.flatMap((n): AdfNode[] => {
      if (allowed.has(n.type)) return [n];
      if (n.type === 'heading') {
        return [{ type: 'paragraph', content: (n.content ?? []).map((c) => (c.type === 'text' ? { ...c, marks: [...(c.marks ?? []).filter((m) => m.type !== 'code'), { type: 'strong' }] } : c)) }];
      }
      if (n.type === 'blockquote' || n.type === 'panel' || n.type === 'expand' || n.type === 'nestedExpand') return this.fit(n.content ?? [], allowed);
      if (n.type === 'table') {
        return (n.content ?? []).map((row) => ({
          type: 'paragraph',
          content: (row.content ?? []).flatMap((cell, i) => [
            ...(i ? [{ type: 'text', text: ' | ' }] : []),
            ...(cell.content ?? []).flatMap((p) => (p.type === 'paragraph' ? p.content ?? [] : [])),
          ]),
        }));
      }
      // Only a restored keep token reaches here (markdown yields known types) —
      // pass it through and let Confluence judge, never drop it silently.
      return [n];
    });
  }

  blocks(tokens: any[], i: number, close: string | null): [AdfNode[], number] {
    const out: AdfNode[] = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (close && t.type === close) return [out, i + 1];
      switch (t.type) {
        case 'heading_open':
          out.push({ type: 'heading', attrs: { level: Number(t.tag.slice(1)) }, content: this.inline(tokens[i + 1].children) });
          i += 3;
          continue;
        case 'paragraph_open':
          out.push(...this.paragraph(this.inline(tokens[i + 1].children)));
          i += 3;
          continue;
        case 'fence':
        case 'code_block': {
          const text = t.content.replace(/\n$/, '');
          const lang = String(t.info ?? '').trim().split(/\s+/)[0];
          out.push({ type: 'codeBlock', ...(lang ? { attrs: { language: lang } } : {}), ...(text ? { content: [{ type: 'text', text }] } : {}) });
          i += 1;
          continue;
        }
        case 'hr':
          out.push({ type: 'rule' });
          i += 1;
          continue;
        case 'blockquote_open': {
          const [inner, next] = this.blocks(tokens, i + 1, 'blockquote_close');
          const content = this.fit(inner, QUOTE_OK);
          out.push({ type: 'blockquote', content: content.length ? content : [{ type: 'paragraph' }] });
          i = next;
          continue;
        }
        case 'bullet_list_open':
        case 'ordered_list_open': {
          const [node, next] = this.list(tokens, i);
          out.push(node);
          i = next;
          continue;
        }
        case 'table_open': {
          const [node, next] = this.table(tokens, i);
          out.push(node);
          i = next;
          continue;
        }
        default:
          i += 1;
      }
    }
    return [out, i];
  }

  private list(tokens: any[], i: number): [AdfNode, number] {
    const t = tokens[i];
    const ordered = t.type === 'ordered_list_open';
    const close = ordered ? 'ordered_list_close' : 'bullet_list_close';
    const items: AdfNode[] = [];
    i += 1;
    while (tokens[i].type !== close) {
      const [inner, next] = this.blocks(tokens, i + 1, 'list_item_close');
      let content = this.fit(inner, LIST_ITEM_OK);
      if (!content.length || content[0].type !== 'paragraph') content = [{ type: 'paragraph' }, ...content];
      items.push({ type: 'listItem', content });
      i = next;
    }
    i += 1;
    const TASK = /^\[([ xX])\]\s+/;
    const first = (it: AdfNode) => it.content?.[0]?.content?.[0];
    if (!ordered && items.length && items.every((it) => first(it)?.type === 'text' && TASK.test(first(it)!.text!))) {
      return [
        {
          type: 'taskList',
          attrs: { localId: this.localId() },
          content: items.map((it) => {
            const p = it.content![0];
            const head = first(it)!;
            const state = /^\[[xX]\]/.test(head.text!) ? 'DONE' : 'TODO';
            const rest = head.text!.replace(TASK, '');
            const inline = [...(rest ? [{ ...head, text: rest }] : []), ...(p.content ?? []).slice(1)];
            return { type: 'taskItem', attrs: { localId: this.localId(), state }, ...(inline.length ? { content: inline } : {}) };
          }),
        },
        i,
      ];
    }
    const start = ordered ? Number(t.attrGet('start') ?? 1) : 1;
    return [{ type: ordered ? 'orderedList' : 'bulletList', ...(ordered ? { attrs: { order: start } } : {}), content: items }, i];
  }

  private table(tokens: any[], i: number): [AdfNode, number] {
    const rows: AdfNode[] = [];
    let header = false;
    let row: AdfNode[] = [];
    i += 1;
    while (tokens[i].type !== 'table_close') {
      const k = tokens[i];
      if (k.type === 'thead_open') header = true;
      else if (k.type === 'thead_close') header = false;
      else if (k.type === 'tr_open') row = [];
      else if (k.type === 'tr_close') rows.push({ type: 'tableRow', content: row });
      else if (k.type === 'th_open' || k.type === 'td_open') {
        const content = this.fit(this.paragraph(this.inline(tokens[i + 1].children)), CELL_OK);
        row.push({ type: header ? 'tableHeader' : 'tableCell', attrs: {}, content: content.length ? content : [{ type: 'paragraph' }] });
        i += 2;
      }
      i += 1;
    }
    return [{ type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default', localId: this.localId() }, content: rows }, i + 1];
  }
}

const FENCE_OPEN_RE = /^\s*:::(panel|expand)\b\s*(.*)$/;
const FENCE_CLOSE_RE = /^\s*:::\s*$/;
const PANEL_TYPES = new Set(['info', 'note', 'tip', 'warning', 'error', 'success', 'custom']);

/**
 * Markdown (with optional keep tokens and :::panel / :::expand fences) → ADF
 * block nodes. `keep` resolves tokens back to the page's original elements;
 * without it (a new page) any token is an error.
 */
export function markdownToAdfBlocks(markdown: string, keep: KeepMap = new Map()): AdfNode[] {
  const b = new Builder(keep);
  const parse = (text: string) => b.blocks(md.parse(text, {}), 0, null)[0];

  type Frame = { kind: string; arg: string; lines: string[]; children: AdfNode[] };
  const root: Frame = { kind: 'doc', arg: '', lines: [], children: [] };
  const stack: Frame[] = [root];
  const flushLines = (f: Frame) => {
    if (f.lines.some((l) => l.trim())) f.children.push(...parse(f.lines.join('\n')));
    f.lines = [];
  };
  const closeFrame = (f: Frame): AdfNode => {
    flushLines(f);
    if (f.kind === 'panel') {
      const panelType = PANEL_TYPES.has(f.arg.trim()) ? f.arg.trim() : 'info';
      const content = b.fit(f.children, PANEL_OK);
      return { type: 'panel', attrs: { panelType }, content: content.length ? content : [{ type: 'paragraph' }] };
    }
    const content = b.fit(f.children, new Set([...PANEL_OK, 'panel', 'blockquote', 'table', 'heading'].filter((t) => !EXPAND_BLOCKED.has(t))));
    return { type: 'expand', attrs: { title: f.arg.trim() }, content: content.length ? content : [{ type: 'paragraph' }] };
  };

  let inCode: string | null = null;
  for (const line of markdown.split('\n')) {
    const top = stack[stack.length - 1];
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (inCode) {
      if (fence && fence[1].startsWith(inCode)) inCode = null;
      top.lines.push(line);
      continue;
    }
    if (fence) {
      inCode = fence[1];
      top.lines.push(line);
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      flushLines(top);
      stack.push({ kind: open[1], arg: open[2] ?? '', lines: [], children: [] });
      continue;
    }
    if (FENCE_CLOSE_RE.test(line) && stack.length > 1) {
      const done = stack.pop()!;
      stack[stack.length - 1].children.push(closeFrame(done));
      continue;
    }
    top.lines.push(line);
  }
  while (stack.length > 1) {
    const done = stack.pop()!;
    stack[stack.length - 1].children.push(closeFrame(done));
  }
  flushLines(root);
  return root.children;
}

/** A complete ADF doc from markdown — for a new page. */
export function markdownToAdf(markdown: string): AdfDoc {
  return { type: 'doc', version: 1, content: markdownToAdfBlocks(markdown) };
}

// ─────────────────────────── sections & edits ───────────────────────────

interface Section {
  container: AdfNode[];
  start: number;
  /** Exclusive. */
  end: number;
  level: number;
  title: string;
}

function containers(doc: AdfDoc): AdfNode[][] {
  const out: AdfNode[][] = [doc.content];
  const walk = (nodes: AdfNode[]) => {
    for (const n of nodes) {
      if (TRANSPARENT.has(n.type) && n.content) {
        if (n.type === 'layoutColumn') out.push(n.content);
        walk(n.content);
      }
    }
  };
  walk(doc.content);
  return out;
}

function allSections(doc: AdfDoc): Section[] {
  const out: Section[] = [];
  for (const container of containers(doc)) {
    container.forEach((n, i) => {
      if (n.type !== 'heading') return;
      const level = Number(n.attrs?.level ?? 1);
      let end = i + 1;
      while (end < container.length && !(container[end].type === 'heading' && Number(container[end].attrs?.level ?? 1) <= level)) end++;
      out.push({ container, start: i, end, level, title: plainText(n).trim() });
    });
  }
  return out;
}

/** `### Cause`, and `### Cause [2]` for a repeated heading — the form `section` accepts back. */
function sectionLabels(all: Section[]): string[] {
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const s of all) total.set(`${s.level} ${normTitle(s.title)}`, (total.get(`${s.level} ${normTitle(s.title)}`) ?? 0) + 1);
  return all.map((s) => {
    const k = `${s.level} ${normTitle(s.title)}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return `${'#'.repeat(s.level)} ${s.title}${(total.get(k) ?? 0) > 1 ? ` [${n}]` : ''}`;
  });
}

const normTitle = (s: string) => s.replace(/^\s*#{1,6}\s*/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function findSection(doc: AdfDoc, heading: string): Section {
  const nth = /\s\[(\d+)\]\s*$/.exec(heading);
  const bare = nth ? heading.slice(0, nth.index) : heading;
  const want = normTitle(bare);
  const wantLevel = /^\s*(#{1,6})\s/.exec(bare)?.[1].length;
  const all = allSections(doc);
  const matches = all.filter((s) => normTitle(s.title) === want && (!wantLevel || s.level === wantLevel));
  if (nth && matches[Number(nth[1]) - 1]) return matches[Number(nth[1]) - 1];
  if (matches.length === 1) return matches[0];
  const listing = sectionLabels(all).join(', ') || '(this page has no headings — use mode "replace_page" or "append")';
  if (!matches.length) throw new Error(`No section headed "${heading}" on this page. Its sections are: ${listing}`);
  throw new Error(`"${heading}" heads ${matches.length} sections on this page — pass it exactly as listed, e.g. "${'#'.repeat(matches[0].level)} ${matches[0].title} [2]" for the second. Sections: ${listing}`);
}

export type EditMode = 'replace_section' | 'insert_after_section' | 'append' | 'replace_page';

export interface PageEdit {
  doc: AdfDoc;
  /** The affected part of the page, as markdown, before and after — what the review card diffs. */
  before: string;
  after: string;
}

/**
 * Apply one edit to a page body without touching anything outside it.
 * `markdown` is the new content: for `replace_section`, the whole section
 * including its heading line (so it can be renamed or removed).
 */
export function editPage(doc: AdfDoc, args: { mode: EditMode; section?: string; markdown: string }): PageEdit {
  const next: AdfDoc = JSON.parse(JSON.stringify(doc));
  const keep: KeepMap = new Map();
  const renderer = new Renderer(keep);
  renderer.index(next.content);
  const nodes = markdownToAdfBlocks(args.markdown ?? '', keep);
  const show = (ns: AdfNode[]) => renderer.blocks(ns).join('\n').trim();

  switch (args.mode) {
    case 'replace_page': {
      const before = show(next.content);
      next.content = nodes;
      return { doc: next, before, after: show(nodes) };
    }
    case 'append': {
      next.content.push(...nodes);
      return { doc: next, before: '', after: show(nodes) };
    }
    case 'replace_section':
    case 'insert_after_section': {
      if (!args.section?.trim()) throw new Error(`mode "${args.mode}" needs \`section\`: the heading of the section to target.`);
      const s = findSection(next, args.section);
      const old = s.container.slice(s.start, s.end);
      if (args.mode === 'replace_section') {
        s.container.splice(s.start, s.end - s.start, ...nodes);
        return { doc: next, before: show(old), after: show(nodes) };
      }
      s.container.splice(s.end, 0, ...nodes);
      return { doc: next, before: '', after: show(nodes) };
    }
    default:
      throw new Error(`Unknown mode "${(args as { mode: string }).mode}". Use replace_section, insert_after_section, append or replace_page.`);
  }
}
