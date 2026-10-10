import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { STORAGE_KEYS } from '../../../constants';
import { GitHubOAuthService } from '../deployment/githubOAuthService';
import { BITBUCKET_CLOUD, BitbucketHost } from './bitbucket';
import { GITHUB_COM, GitHubHost } from './github';
import { GhLogin, ghAccounts, ghInstalled, ghToken, startGhLogin } from './ghCli';
import { GitLabHost } from './gitlab';
import type { CodeHost, CodeHostConnection, CodeHostConnectionSummary, CodeHostKind, RepoRef } from './types';
import { KIND_LABEL } from './types';

/**
 * The user's code-host connections (GitHub, GitLab, Bitbucket Cloud), one per
 * host, kept in SecretStorage. github.com can connect through the OAuth App
 * the deployment feature already has; everything else — Enterprise, GitLab,
 * Bitbucket — connects with a token, because those OAuth apps are registered
 * per instance. Tokens never reach the webview.
 */

const DEFAULT_HOST: Record<CodeHostKind, string> = { github: GITHUB_COM, gitlab: 'gitlab.com', bitbucket: BITBUCKET_CLOUD };

/** "https://git.acme.com/org/repo" → "git.acme.com"; undefined when it is not a hostname. */
export function normalizeHost(input: string): string | undefined {
  const host = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/^api\.github\.com$/, GITHUB_COM);
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/.test(host) ? host : undefined;
}

/** The provider a hostname most likely is, for the common hosted ones. */
export const kindForHost = (host: string): CodeHostKind | undefined =>
  host === GITHUB_COM ? 'github' : host === 'gitlab.com' ? 'gitlab' : host === BITBUCKET_CLOUD ? 'bitbucket' : undefined;

function build(conn: CodeHostConnection, token: string): CodeHost {
  switch (conn.kind) {
    case 'github':
      return new GitHubHost(conn.host, token, conn.login);
    case 'gitlab':
      return new GitLabHost(conn.host, token, conn.login);
    case 'bitbucket':
      return new BitbucketHost(conn.username ?? '', token, conn.login);
  }
}

function originOf(cwd: string): Promise<string> {
  return new Promise((resolve) =>
    execFile('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 5_000, windowsHide: true }, (e, out) => resolve(e ? '' : out.trim())));
}

export class CodeHostConnections {
  private oauth: GitHubOAuthService;
  private ghLogin?: GhLogin;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.oauth = new GitHubOAuthService(context);
  }

  private async read(): Promise<CodeHostConnection[]> {
    const raw = await this.context.secrets.get(STORAGE_KEYS.CODE_HOST_CONNECTIONS);
    if (!raw) return [];
    try {
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  private async write(list: CodeHostConnection[]): Promise<void> {
    if (list.length) await this.context.secrets.store(STORAGE_KEYS.CODE_HOST_CONNECTIONS, JSON.stringify(list));
    else await this.context.secrets.delete(STORAGE_KEYS.CODE_HOST_CONNECTIONS);
  }

  /** Who is connected, for the settings card. */
  async summaries(): Promise<CodeHostConnectionSummary[]> {
    return (await this.read()).map(({ id, kind, host, login, source }) => ({ id, kind, host, login, source }));
  }

  /** A usable adapter per connection; one whose credential can't be read is skipped. */
  async hosts(): Promise<CodeHost[]> {
    const out: CodeHost[] = [];
    for (const conn of await this.read()) {
      const token = conn.source === 'oauth' ? await this.oauth.getValidAccessToken().catch(() => undefined) : conn.source === 'gh' ? await ghToken(conn.host) : conn.token;
      if (token) out.push(build(conn, token));
    }
    return out;
  }

  /**
   * The repo `cwd`'s origin points at when the GitHub CLI is already signed in
   * to that host: no connection needed, `gh` is the credential. Undefined for
   * a host `gh` doesn't know (GitLab, Bitbucket, or an Enterprise host it is
   * not signed in to).
   */
  async viaGhCli(cwd: string): Promise<{ host: CodeHost; repo: RepoRef } | null> {
    const remote = await originOf(cwd);
    const hostname = /^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)([^/:]+)/.exec(remote)?.[1]?.toLowerCase();
    if (!hostname) return null;
    const token = await ghToken(hostname);
    if (!token) return null;
    const host = new GitHubHost(hostname, token);
    const repo = host.parseRemote(remote);
    return repo ? { host, repo } : null;
  }

  /**
   * github.com through the GitHub CLI's sign-in, for when there is no folder to
   * read an origin from. Enough for "my pull requests"; per-repo features
   * still need the folder.
   */
  async defaultGitHub(): Promise<CodeHost | null> {
    const token = await ghToken(GITHUB_COM, (await this.ghAccountChoice()).selected);
    return token ? new GitHubHost(GITHUB_COM, token) : null;
  }

  /**
   * The `gh` accounts on github.com and the one Home uses. With a single
   * account there is nothing to choose; with several, the user's pick (if it is
   * still signed in) wins and otherwise gh's active account does. Only ever
   * read: `gh`'s active account is never switched, so other repos are untouched.
   */
  async ghAccountChoice(): Promise<{ accounts: string[]; selected?: string }> {
    const found = await ghAccounts(GITHUB_COM);
    const accounts = found.map((a) => a.login);
    if (accounts.length < 2) return { accounts };
    const pinned = this.context.globalState.get<string>(STORAGE_KEYS.CODE_HOST_GH_ACCOUNT);
    return { accounts, selected: pinned && accounts.includes(pinned) ? pinned : found.find((a) => a.active)?.login };
  }

  async setGhAccount(login: string): Promise<void> {
    if (!(await this.ghAccountChoice()).accounts.includes(login)) throw new Error(`${login} isn't signed in to the GitHub CLI.`);
    await this.context.globalState.update(STORAGE_KEYS.CODE_HOST_GH_ACCOUNT, login);
  }

  /** For Home: a gh-sourced github.com host re-pointed at the chosen account; anything else is returned as is. */
  async forHome(host: CodeHost): Promise<CodeHost> {
    if (host.kind !== 'github' || host.host !== GITHUB_COM) return host;
    return (await this.defaultGitHub().catch(() => null)) ?? host;
  }

  /** The connection that owns the repo `cwd`'s origin points at (or, failing that, the GitHub CLI's sign-in), and that repo. */
  async forRepo(cwd: string): Promise<{ host: CodeHost; repo: RepoRef } | null> {
    const remote = await originOf(cwd);
    if (!remote) return null;
    for (const host of await this.hosts()) {
      const repo = host.parseRemote(remote);
      if (repo) return { host, repo };
    }
    return this.viaGhCli(cwd);
  }

  /** Validates the credential by asking the host who it belongs to; stores nothing unless that works. */
  async connectWithToken(input: { kind: CodeHostKind; host?: string; username?: string; token: string }): Promise<CodeHostConnectionSummary> {
    const host = input.kind === 'bitbucket' ? BITBUCKET_CLOUD : normalizeHost(input.host || DEFAULT_HOST[input.kind]);
    if (!host) throw new Error(`Enter the ${KIND_LABEL[input.kind]} host, like ${DEFAULT_HOST[input.kind]}.`);
    const token = input.token.trim();
    if (!token) throw new Error('Paste an access token.');
    if (input.kind === 'bitbucket' && !input.username?.trim()) throw new Error('Enter your Bitbucket username (or account email for an API token).');
    const conn: CodeHostConnection = { id: randomUUID(), kind: input.kind, host, username: input.username?.trim(), token, login: '', source: 'token', connectedAt: Date.now() };
    const adapter = build(conn, token);
    const { login, warning } = await adapter.verify().catch((e) => {
      if (e instanceof Error && /^(GitHub|GitLab|Bitbucket|This |Not found)/.test(e.message)) throw e;
      throw new Error(`Could not reach ${host}. Check the host name and your network.`);
    });
    conn.login = login;
    // One connection per host: connecting again replaces the old credential.
    await this.write([...(await this.read()).filter((c) => !(c.kind === conn.kind && c.host === conn.host)), conn]);
    return { id: conn.id, kind: conn.kind, host, login, source: 'token', warning };
  }

  /** github.com only — the OAuth App doesn't exist on any other host. */
  async connectGitHubOAuth(): Promise<CodeHostConnectionSummary> {
    const tokens = await this.oauth.startOAuthFlow();
    const adapter = new GitHubHost(GITHUB_COM, tokens.accessToken);
    const { login, warning } = await adapter.verify();
    const conn: CodeHostConnection = { id: randomUUID(), kind: 'github', host: GITHUB_COM, login, source: 'oauth', connectedAt: Date.now() };
    await this.write([...(await this.read()).filter((c) => !(c.kind === 'github' && c.host === GITHUB_COM)), conn]);
    return { id: conn.id, kind: 'github', host: GITHUB_COM, login, source: 'oauth', warning };
  }

  /**
   * One-click sign-in through the GitHub CLI, for any GitHub host (Enterprise
   * above all). Reuses an existing `gh` login when there is one; otherwise runs
   * `gh auth login --web` and reports the one-time code through `onCode`.
   */
  async connectWithGhCli(hostInput: string, onCode: (info: { code: string; url: string }) => void, openUrl: (url: string) => void): Promise<CodeHostConnectionSummary> {
    const host = normalizeHost(hostInput || GITHUB_COM);
    if (!host) throw new Error('Enter the GitHub host, like github.com or git.yourcompany.com.');
    if (!(await ghInstalled())) throw new Error("The GitHub CLI isn't installed. Install it from https://cli.github.com, then try again.");
    let token = await ghToken(host);
    if (!token) {
      this.ghLogin = startGhLogin(host, onCode, openUrl);
      try {
        await this.ghLogin.promise;
      } finally {
        this.ghLogin = undefined;
      }
      token = await ghToken(host);
      if (!token) throw new Error('GitHub CLI signed in but returned no token. Try again.');
    }
    const { login, warning } = await new GitHubHost(host, token).verify();
    const conn: CodeHostConnection = { id: randomUUID(), kind: 'github', host, login, source: 'gh', connectedAt: Date.now() };
    await this.write([...(await this.read()).filter((c) => !(c.kind === 'github' && c.host === host)), conn]);
    return { id: conn.id, kind: 'github', host, login, source: 'gh', warning };
  }

  cancelOAuth(): void {
    this.oauth.cancelOAuthFlow();
    this.ghLogin?.cancel();
  }

  /** Forgets one connection; the deployment feature's own GitHub credentials are separate. */
  async remove(id: string): Promise<void> {
    await this.write((await this.read()).filter((c) => c.id !== id));
  }
}
