/**
 * Scans text for top-level balanced `{...}` blocks (string-aware), so several
 * back-to-back JSON objects are each recovered — local models routinely emit
 * `{"name": ...} {"name": ...}` as one blob, which a plain JSON.parse rejects.
 *
 * Shared between the agent tool loop (salvaging text-emitted tool calls) and
 * the exploration phase (parsing explorer output), so both benefit from the
 * same fence/tag/concatenation tolerance instead of drifting apart.
 */
export function extractBalancedJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0 && --depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}
