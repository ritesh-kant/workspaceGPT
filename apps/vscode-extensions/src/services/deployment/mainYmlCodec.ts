import type { MainYmlCodec } from './machEnvTarget';

/**
 * Default {@link MainYmlCodec}: treats `main.yml` as flat top-level `KEY: value`
 * entries — the common env-var layout.
 *
 * This is a REASONABLE DEFAULT, not the confirmed org schema. Swap it once the
 * real `main.yml` + `update-main-file/action.yml` are known (open item #1 in
 * DEPLOYMENT-AUTOMATION-DESIGN.md) — e.g. if vars live under a nested `env:` map
 * or carry quoting/typing rules. `set` edits only the matching line so
 * surrounding formatting and comments survive, and appends when the key is
 * absent, mirroring `setComponentVersion`'s surgical-edit approach.
 */

/** A top-level `key: value` line. Keys may be dotted (e.g. `a.b.c`). */
const ENTRY_RE = /^([A-Za-z_][\w.-]*):[ \t]*(.*)$/;

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

/** Escape a key for use inside a per-line RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const defaultMainYmlCodec: MainYmlCodec = {
  parse(text: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const raw of text.split(/\r?\n/)) {
      // Only top-level entries (no leading indentation) — nested keys are
      // out of scope for the default flat codec.
      if (/^\s/.test(raw)) continue;
      const line = raw.replace(/^﻿/, '');
      if (!line || line.trimStart().startsWith('#')) continue;
      const m = line.match(ENTRY_RE);
      if (!m) continue;
      const [, key, rest] = m;
      // Drop a trailing inline comment only when it's clearly one (space + #),
      // so values that legitimately contain `#` aren't truncated.
      const value = stripQuotes(rest.replace(/\s+#.*$/, ''));
      if (!map.has(key)) map.set(key, value);
    }
    return map;
  },

  set(text: string, key: string, value: string): { text: string; changed: boolean } {
    const lines = text.split(/\r?\n/);
    const lineRe = new RegExp(`^(${escapeRe(key)}:[ \\t]*)(.*)$`);
    for (let i = 0; i < lines.length; i++) {
      if (/^\s/.test(lines[i])) continue;
      const m = lines[i].match(lineRe);
      if (!m) continue;
      if (stripQuotes(m[2]) === value) return { text, changed: false };
      lines[i] = `${m[1]}${value}`;
      return { text: lines.join('\n'), changed: true };
    }
    // Absent → append at the end (keep a single trailing newline).
    const trimmed = text.replace(/\s*$/, '');
    return { text: `${trimmed}\n${key}: ${value}\n`, changed: true };
  },
};
