/**
 * Minimal .env loader for the eval/bench scripts — no dependency, no
 * interpolation. Reads KEY=VALUE lines from packages/agent-evals/.env (if
 * present) into process.env without overriding variables already set in the
 * shell, so `WGPT_BENCH_MODEL=x pnpm smoke` still wins over the file.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv(file = path.join(pkgRoot, '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env — fine, defaults/shell env apply
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
