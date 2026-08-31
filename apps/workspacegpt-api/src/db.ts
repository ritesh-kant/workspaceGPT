import { ConfigRow, RuntimeConfig, configQuery, resolveConfig } from './config';
import type { Env } from './env';

export interface UserRow {
  id: string;
  login: string;
  created_at: number;
  github_created_at: string;
  plan: string;
  status: string;
  /** Per-user daily cap override; NULL means "use the plan's limit". */
  daily_request_limit: number | null;
}

/** Insert the user on first sign-in (only ever called after the age gate passes); otherwise just refresh their `login` (GitHub handles can change). */
export async function upsertUser(
  env: Env,
  githubId: number,
  login: string,
  githubCreatedAt: string
): Promise<UserRow> {
  const id = String(githubId);
  const existing = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
  if (existing) {
    if (existing.login !== login) {
      await env.DB.prepare('UPDATE users SET login = ? WHERE id = ?').bind(login, id).run();
    }
    return { ...existing, login };
  }

  const row: UserRow = {
    id,
    login,
    created_at: Date.now(),
    github_created_at: githubCreatedAt,
    plan: 'free',
    status: 'active',
    // Left NULL on purpose: a new account follows its plan's limit until
    // someone deliberately overrides it.
    daily_request_limit: null,
  };
  await env.DB.prepare(
    'INSERT INTO users (id, login, created_at, github_created_at, plan, status) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(row.id, row.login, row.created_at, row.github_created_at, row.plan, row.status)
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
