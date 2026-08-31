import type { Env } from './env';

export interface UserRow {
  id: string;
  login: string;
  created_at: number;
  github_created_at: string;
  plan: string;
  status: string;
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
