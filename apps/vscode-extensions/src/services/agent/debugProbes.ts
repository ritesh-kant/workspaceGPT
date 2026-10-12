/**
 * Log probes for Debug mode (docs/design/debug-mode.md §5).
 *
 * A probe is ONE temporary log line the agent inserts to test a hypothesis,
 * tagged `WGPT-PROBE:<id>` so it can be found in command output and removed
 * again. Everything here is pure and vscode-free (unit-tested headlessly): the
 * host adapter in chatService does the file I/O, the checkpointing and the
 * permission decision.
 *
 * Probes are only ever inserted as a whole line and removed by marker, so a
 * leftover is always findable with a grep.
 */

export const PROBE_MARKER = 'WGPT-PROBE';
export const MAX_PROBES_PER_RUN = 12;
const MAX_EXPR_CHARS = 160;
const MAX_LABEL_CHARS = 40;

const PROBE_ID_RE = /\bWGPT-PROBE:(p\d+)\b/;
const PROBE_ID_GLOBAL_RE = /\bWGPT-PROBE:(p\d+)\b/g;

/** A name that looks like a credential. A probe prints values, so these are refused, not masked. */
const SECRET_NAME_RE = /pass(word|wd)?|secret|token|api[_-]?key|authorization|credential|private[_-]?key|\bssn\b|cookie|session[_-]?id/i;

/** Languages a probe line can be written for, and how. `E` is the expression, `P` the quoted prefix. */
type Family = 'js' | 'py' | 'go' | 'rb' | 'java' | 'cs' | 'rs' | 'php';

const FAMILY_BY_EXT: Readonly<Record<string, Family>> = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js',
  py: 'py',
  go: 'go',
  rb: 'rb',
  java: 'java', kt: 'java', kts: 'java',
  cs: 'cs',
  rs: 'rs',
  php: 'php',
};

export function probeFamily(filePath: string): Family | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase();
  return (ext && FAMILY_BY_EXT[ext]) || null;
}

/** Why this expression may not be probed, or null. The probe must observe, never change, behaviour. */
export function checkProbeExpr(expr: string): string | null {
  const e = expr.trim();
  if (!e) return 'expr must be non-empty.';
  if (e.length > MAX_EXPR_CHARS) return `expr is over ${MAX_EXPR_CHARS} characters — probe a smaller value.`;
  if (/[\n\r`;]|\/\/|\/\*/.test(e)) return 'expr must be a single expression: no newlines, backticks, semicolons or comments.';
  // Assignment (but not ==, ===, !=, <=, >=, =>), increment/decrement.
  if (/(^|[^=!<>])=(?![=>])/.test(e) || /\+\+|--/.test(e)) return 'expr must not assign or increment — a probe observes, it does not change state.';
  if (/\b(await|yield|delete|throw|return)\b/.test(e)) return 'expr must not use await/yield/delete/throw/return — a probe must not change control flow.';
  if (SECRET_NAME_RE.test(e)) return 'expr names something that looks like a credential or personal data; probe a non-sensitive value (a length, a type, an id).';
  let depth = 0;
  for (const ch of e) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) return 'expr has unbalanced brackets.';
  return null;
}

/** Labels end up inside a string literal: keep them to plain words. */
export function sanitizeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9 _.:\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS) || 'value';
}

/** The probe line for `family`, without indentation. */
export function probeLineFor(family: Family, id: string, label: string, expr: string): string {
  const tag = `${PROBE_MARKER}:${id}`;
  const e = expr.trim();
  switch (family) {
    case 'js':
      // Arrow IIFE: keeps this/arguments, and a throwing expression cannot throw out of the probe.
      return `console.error('${tag}', '${label}', (() => { try { return (${e}); } catch (e) { return '<probe threw: ' + e + '>'; } })());`;
    case 'py':
      return `print("${tag}", "${label}", ${e}, flush=True)`;
    case 'go':
      return `println("${tag}", "${label}", ${e})`;
    case 'rb':
      return `warn("${tag}", "${label}", (${e}).inspect)`;
    case 'java':
      return `System.err.println("${tag} ${label} " + (${e}));`;
    case 'cs':
      return `System.Console.Error.WriteLine("${tag} ${label} " + (${e}));`;
    case 'rs':
      return `eprintln!("${tag} ${label} {:?}", ${e});`;
    case 'php':
      return `error_log("${tag} ${label} " . print_r(${e}, true));`;
  }
}

const CONTINUES_RE = /(,|\(|\[|\+|-|\*|\/|=|&&|\|\||\?|\.|\\|=>)\s*$/;
const STARTS_CONTINUATION_RE = /^(\}|\)|\]|else\b|elif\b|except\b|catch\b|finally\b|case\b|default\s*:|\.|\?|:|&&|\|\||,|\+|<|\/>|@)/;
const OBJECT_KEY_RE = /^(\.\.\.|[\w$]+\s*:|['"][^'"]+['"]\s*:|\[[^\]]+\]\s*:)/;

/**
 * Why a probe cannot go BEFORE `lines[idx]`, or null. Inserting inside a
 * multi-line expression, an object literal, JSX, or between `}` and `else`
 * breaks the file, so those spots are refused and the model picks a statement
 * boundary. Failure costs one retry, never a broken file.
 */
export function checkInsertionPoint(family: Family, lines: readonly string[], idx: number): string | null {
  if (idx < 0 || idx >= lines.length) return `line is outside the file (it has ${lines.length} lines).`;
  const target = lines[idx].trim();
  if (!target) return 'that line is blank — pick the first line of a statement.';
  if (STARTS_CONTINUATION_RE.test(target)) return `a probe cannot go before "${target.slice(0, 40)}" — it continues the previous statement. Pick the first line of a statement.`;
  let prev = idx - 1;
  while (prev >= 0 && (!lines[prev].trim() || /^\s*(\/\/|#|\*|\/\*)/.test(lines[prev]))) prev--;
  if (prev >= 0) {
    const p = lines[prev].trim();
    // Python's trailing colon opens a block (fine); anywhere else it, like an operator or comma, means the statement goes on.
    const continues = family === 'py' ? CONTINUES_RE.test(p) : CONTINUES_RE.test(p) || (/:\s*$/.test(p) && !/^(case\b|default\b)/.test(p));
    if (continues && !/\)\s*=>\s*\{?$/.test(p)) return `the previous line ("${p.slice(-40)}") continues onto this one — pick the first line of a statement.`;
    if (family === 'js' && /[{,]\s*$/.test(p) && OBJECT_KEY_RE.test(target)) return 'that line is inside an object literal — pick a statement line.';
  }
  return null;
}

/** The leading whitespace of `line`. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/** `content` with `probe` inserted (indented like the target) before 1-based `line`. */
export function insertProbeLine(content: string, line: number, probe: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const at = Math.min(Math.max(line - 1, 0), lines.length);
  lines.splice(at, 0, `${indentOf(lines[at] ?? '')}${probe}`);
  return lines.join(eol);
}

/** Ids of every probe still present in `content`. */
export function probeIdsIn(content: string): string[] {
  const ids = new Set<string>();
  for (const m of content.matchAll(PROBE_ID_GLOBAL_RE)) ids.add(m[1]);
  return [...ids];
}

/** `content` without the probe lines for `ids` (all probes when omitted). */
export function removeProbeLines(content: string, ids?: readonly string[]): { content: string; removed: number } {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  let removed = 0;
  const kept = content.split(/\r?\n/).filter((line) => {
    const id = PROBE_ID_RE.exec(line)?.[1];
    if (id && (!ids || ids.includes(id))) {
      removed++;
      return false;
    }
    return true;
  });
  return { content: kept.join(eol), removed };
}

export interface ProbeLines {
  count: number;
  /** Sampled values, in order seen: the first few and the last few, consecutive repeats collapsed. */
  samples: string[];
}

const SAMPLE_HEAD = 5;
const SAMPLE_TAIL = 3;
const MAX_SAMPLE_CHARS = 300;

/**
 * The probe lines in a command's output, grouped by probe id. A probe inside a
 * loop can fire thousands of times: keep the first and last few so the model
 * sees how the value starts and where it ends up, with the count.
 */
export function extractProbeLines(output: string): Record<string, ProbeLines> {
  const raw = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/)) {
    const m = new RegExp(`${PROBE_MARKER}:(p\\d+)\\s?(.*)$`).exec(line);
    if (!m) continue;
    const list = raw.get(m[1]) ?? [];
    list.push(m[2].trim().slice(0, MAX_SAMPLE_CHARS));
    raw.set(m[1], list);
  }
  const out: Record<string, ProbeLines> = {};
  for (const [id, values] of raw) {
    const collapsed: string[] = [];
    for (const v of values) if (collapsed[collapsed.length - 1] !== v) collapsed.push(v);
    const samples =
      collapsed.length <= SAMPLE_HEAD + SAMPLE_TAIL
        ? collapsed
        : [...collapsed.slice(0, SAMPLE_HEAD), `… ${collapsed.length - SAMPLE_HEAD - SAMPLE_TAIL} more distinct values …`, ...collapsed.slice(-SAMPLE_TAIL)];
    out[id] = { count: values.length, samples };
  }
  return out;
}
