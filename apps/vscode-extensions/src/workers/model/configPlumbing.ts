/**
 * A change that starts reading a NEW environment variable is half done until
 * the variable reaches the process: per-environment values, the infra map
 * that forwards them into the container, the .env.example. No lint, typecheck
 * or test sees that gap — every check is green while the flag can never be
 * turned on (#1588522: `DD_TRACE_V6_ENABLED` was read in six services, the
 * user had to ask for the deploymentVariables/*.yml entries, then a reviewer
 * found terraform/ecs.tf never forwarded it).
 *
 * The facts come from the run and the repo, not from wording: the keys are
 * the ones the run's own writes introduced, and where a key must be declared
 * is wherever a SIBLING key — one the same component already reads — is
 * declared outside code. The result is a nudge; the model may justify a file.
 */

export interface PlumbingSearchArgs {
  query: string;
  glob?: string;
  caseSensitive: true;
  outputMode?: 'files_with_matches';
}
export interface PlumbingSearchResult {
  matches?: { file: string; text: string }[];
  files?: string[];
  /** Set when the exact query had no hits and the results are a fallback. */
  note?: string;
  partial?: boolean;
}
export type PlumbingSearch = (args: PlumbingSearchArgs) => Promise<PlumbingSearchResult>;

export interface PlumbingGap {
  key: string;
  /** Where the run added the read. */
  readAt: string;
  sibling: string;
  missingFrom: string[];
}

const KEY = '([A-Z][A-Z0-9_]{2,})';
const ENV_READ_RES: RegExp[] = [
  new RegExp(`process\\.env\\.${KEY}\\b`, 'g'),
  new RegExp(`process\\.env\\[\\s*['"\`]${KEY}['"\`]\\s*\\]`, 'g'),
  new RegExp(`import\\.meta\\.env\\.${KEY}\\b`, 'g'),
  new RegExp(`os\\.environ(?:\\.get)?[\\[(]\\s*['"]${KEY}['"]`, 'g'),
  new RegExp(`\\b(?:os\\.getenv|os\\.Getenv|System\\.getenv|Environment\\.GetEnvironmentVariable|ENV\\.fetch)\\(\\s*['"]${KEY}['"]`, 'g'),
  new RegExp(`\\bENV\\[\\s*['"]${KEY}['"]\\s*\\]`, 'g'),
];
/** One ripgrep pattern that finds candidate lines; envKeysIn extracts the keys. */
const ENV_READ_QUERY = 'process\\.env|import\\.meta\\.env|os\\.environ|getenv|Getenv|GetEnvironmentVariable|ENV\\[|ENV\\.fetch';

/** Set by the platform or the runtime, never declared by the repo. */
const AMBIENT_KEYS = new Set(['NODE_ENV', 'PORT', 'HOME', 'PATH', 'DEBUG', 'HOSTNAME', 'PWD', 'USER', 'LANG', 'SHELL', 'TMPDIR']);
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?|py|go|java|kt|cs|rb|php|rs|scala|swift|vue|svelte)$/i;
const NOT_A_DECLARATION_RE = /(?:\.(?:md|mdx|txt|rst|lock|snap)$)|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|CHANGELOG[^/]*)$|(?:^|\/)(?:node_modules|dist|build|\.git)\//i;
const MAX_SIBLINGS = 3;
const MAX_LISTED = 12;

export function envKeysIn(text: string): string[] {
  const keys = new Set<string>();
  for (const re of ENV_READ_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) keys.add(m[1]);
  }
  return [...keys];
}

/** Keys a write introduced: in the new text and not in the text it replaced. */
export function newEnvKeysFromWrite(toolName: string, argsJson: string): string[] {
  let args: { content?: unknown; oldString?: unknown; newString?: unknown; edits?: unknown };
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    return [];
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (toolName === 'create_file') return envKeysIn(str(args.content)).filter((k) => !AMBIENT_KEYS.has(k));
  if (toolName !== 'edit_file') return [];
  const edits = Array.isArray(args.edits) ? (args.edits as { oldString?: unknown; newString?: unknown }[]) : [];
  const pairs = [...edits, { oldString: args.oldString, newString: args.newString }];
  const before = new Set(envKeysIn(pairs.map((e) => str(e?.oldString)).join('\n')));
  return envKeysIn(pairs.map((e) => str(e?.newString)).join('\n')).filter((k) => !before.has(k) && !AMBIENT_KEYS.has(k));
}

/** The deployable unit a source file belongs to: the folder above its src/. */
export function componentRoot(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const src = p.indexOf('/src/');
  if (src > 0) return p.slice(0, src);
  if (p.startsWith('src/')) return '';
  const slash = p.lastIndexOf('/');
  return slash > 0 ? p.slice(0, slash) : '';
}

const trusted = (r: PlumbingSearchResult | null | undefined): r is PlumbingSearchResult => !!r && !r.note && !r.partial;

export async function findConfigPlumbingGaps(newKeys: Map<string, string>, search: PlumbingSearch): Promise<PlumbingGap[]> {
  const byRoot = new Map<string, [string, string][]>();
  for (const [key, readAt] of newKeys) {
    const root = componentRoot(readAt);
    byRoot.set(root, [...(byRoot.get(root) ?? []), [key, readAt]]);
  }
  const gaps: PlumbingGap[] = [];
  for (const [root, entries] of byRoot) {
    const glob = root ? `${root}/**` : undefined;
    const reads = await search({ query: ENV_READ_QUERY, glob, caseSensitive: true });
    if (!trusted(reads)) continue;
    const counts = new Map<string, number>();
    for (const m of reads.matches ?? []) {
      if (!CODE_FILE_RE.test(m.file)) continue;
      for (const k of envKeysIn(m.text)) {
        if (newKeys.has(k) || AMBIENT_KEYS.has(k)) continue;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    const siblings = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SIBLINGS).map(([k]) => k);
    let sibling = '';
    let declaredIn: string[] = [];
    for (const s of siblings) {
      const r = await search({ query: s, glob, caseSensitive: true, outputMode: 'files_with_matches' });
      if (!trusted(r)) continue;
      const files = (r.files ?? []).filter((f) => !CODE_FILE_RE.test(f) && !NOT_A_DECLARATION_RE.test(f));
      if (files.length) {
        sibling = s;
        declaredIn = files;
        break;
      }
    }
    if (!sibling) continue;
    for (const [key, readAt] of entries) {
      const r = await search({ query: key, glob, caseSensitive: true, outputMode: 'files_with_matches' });
      if (r?.partial) continue;
      // A note means zero exact hits (the rest is a keyword fallback).
      const has = new Set(r && !r.note ? r.files ?? [] : []);
      const missingFrom = declaredIn.filter((f) => !has.has(f));
      if (missingFrom.length) gaps.push({ key, readAt, sibling, missingFrom });
    }
  }
  return gaps;
}

export function configPlumbingNudge(gaps: PlumbingGap[]): string {
  const lines = gaps.map((g) => {
    const shown = g.missingFrom.slice(0, MAX_LISTED).map((f) => `\`${f}\``).join(', ');
    const more = g.missingFrom.length > MAX_LISTED ? ` and ${g.missingFrom.length - MAX_LISTED} more` : '';
    return `- \`${g.key}\` (read in \`${g.readAt}\`): \`${g.sibling}\`, which the same component already reads, is declared in ${shown}${more}. \`${g.key}\` is in none of those.`;
  });
  return (
    'Before this is accepted: your change reads environment variable(s) that nothing outside the code supplies yet, so setting them would have no effect:\n' +
    lines.join('\n') +
    '\nRead those files and follow how the existing variable travels from its per-environment value to the running process, through every file that forwards it, such as an infrastructure environment map. Add the new variable the same way, with a value that keeps today\'s behaviour. ' +
    'If a file genuinely must not carry it, or it is supplied from outside this repository, say which file and why in your report. Then give your final answer.'
  );
}
