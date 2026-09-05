import { ConfigRow, RuntimeConfig, configQuery, resolveConfig } from './config';
import type { Env } from './env';

export interface UserRow {
  id: string;
  login: string;
  email: string | null;
  created_at: number;
  github_created_at: string;
  plan: string;
  status: string;
  /** Request-era per-user override. Left in the schema, no longer read (see 0006_credits.sql). */
  weekly_request_limit: number | null;
  /** Per-user weekly CREDIT cap override; NULL means "use the plan's limit". */
  weekly_credit_limit: number | null;
}

/** Insert the user on first sign-in (only ever called after the age gate passes); otherwise just refresh `login`/`email` (both can change on GitHub's side). */
export async function upsertUser(
  env: Env,
  githubId: number,
  login: string,
  githubCreatedAt: string,
  email: string | null
): Promise<UserRow> {
  const id = String(githubId);
  const existing = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
  if (existing) {
    if (existing.login !== login || existing.email !== email) {
      await env.DB.prepare('UPDATE users SET login = ?, email = ? WHERE id = ?').bind(login, email, id).run();
    }
    return { ...existing, login, email };
  }

  const row: UserRow = {
    id,
    login,
    email,
    created_at: Date.now(),
    github_created_at: githubCreatedAt,
    plan: 'free',
    status: 'active',
    // Left NULL on purpose: a new account follows its plan's limit until
    // someone deliberately overrides it.
    weekly_request_limit: null,
    weekly_credit_limit: null,
  };
  await env.DB.prepare(
    'INSERT INTO users (id, login, email, created_at, github_created_at, plan, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(row.id, row.login, row.email, row.created_at, row.github_created_at, row.plan, row.status)
    .run();
  return row;
}

export async function getUser(env: Env, id: string): Promise<UserRow | null> {
  return (await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>()) ?? null;
}

/**
 * The account row plus the resolved runtime config, in one D1 round trip.
 *
 * Batched rather than fetched separately so reading configuration on every
 * request — which is what makes it changeable without a deploy — costs nothing
 * extra over the user lookup we already had to do.
 */
export async function loadAccount(
  env: Env,
  userId: string
): Promise<{ user: UserRow | null; config: RuntimeConfig }> {
  const [userResult, configResult] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId),
    configQuery(env),
  ]);
  return {
    user: (userResult.results?.[0] as UserRow | undefined) ?? null,
    config: resolveConfig(env, configResult.results as ConfigRow[] | undefined),
  };
}
