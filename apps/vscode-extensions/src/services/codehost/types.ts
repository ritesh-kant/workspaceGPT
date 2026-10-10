/**
 * The code host: where the user's repositories and pull requests live
 * (GitHub, GitLab, Bitbucket Cloud). Not a Knowledge source — nothing here is
 * indexed. One interface so the CI chip, Home's pull requests, Create PR and
 * the agent's tools never care which host a repo is on.
 */

export type CodeHostKind = 'github' | 'gitlab' | 'bitbucket';

export const KIND_LABEL: Record<CodeHostKind, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };

/** owner = GitHub owner, GitLab namespace path (subgroups included), Bitbucket workspace. */
export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PrRef {
  number: number;
  url: string;
  branch: string;
  sha: string;
  state: 'open' | 'merged' | 'closed';
}

export interface CiCheck {
  name: string;
  state: 'pass' | 'fail' | 'pending';
  url?: string;
}

export interface PrSummary {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  branch?: string;
  base?: string;
  updatedAt: string;
  url: string;
  repository?: string;
}

export interface HomePr {
  id: string;
  number: string;
  title: string;
  url: string;
  repository: string;
  author: string;
  updatedAt: string;
  ownership: 'review' | 'mine';
  state: 'review-requested' | 'awaiting-review' | 'changes-requested' | 'approved' | 'draft';
  /** What makes this row "changed" for the unread marker. */
  revisionParts: unknown[];
}

export interface ListPrsOptions {
  scope: 'repo' | 'mine' | 'review-requested';
  state: 'open' | 'closed' | 'all';
  limit: number;
}

export interface CodeHost {
  readonly kind: CodeHostKind;
  readonly host: string;
  /** Signed-in user name, for display; '' until verify() has run. */
  login: string;
  /** "pull request" or, on GitLab, "merge request". */
  readonly prNoun: string;
  /** Proves the credential works and returns who it belongs to. */
  verify(): Promise<{ login: string; warning?: string }>;
  /** The repo an `origin` URL points at, when it is on this host. */
  parseRemote(remote: string): RepoRef | undefined;
  findPr(repo: RepoRef, branch: string): Promise<PrRef | null>;
  checks(repo: RepoRef, pr: PrRef): Promise<CiCheck[]>;
  /** Tail of the failing jobs' logs; undefined when none of the failures have one. */
  failureLog(repo: RepoRef, checks: CiCheck[]): Promise<string | undefined>;
  listPrs(repo: RepoRef | undefined, opts: ListPrsOptions): Promise<PrSummary[]>;
  getPr(repo: RepoRef, number: number, opts: { includeDiff: boolean; includeComments: boolean }): Promise<Record<string, unknown>>;
  /** Opens the PR, or returns the page of the one already open for `head`. */
  createPr(repo: RepoRef, input: { base: string; head: string; title: string; body: string }): Promise<string>;
  getIssue(repo: RepoRef, number: number, opts: { includeComments: boolean }): Promise<Record<string, unknown>>;
  /** Open PRs the user authored or was asked to review; `repo` scopes the review search where the host cannot do it globally. */
  homePrs(repo?: RepoRef): Promise<{ items: HomePr[]; limited: boolean; coverage: string; warning?: string }>;
}

/** What is kept in SecretStorage for one connection. The token never reaches the webview. */
export interface CodeHostConnection {
  id: string;
  kind: CodeHostKind;
  host: string;
  /** Bitbucket only: the Basic-auth user (account email for an API token, or username for an app password). */
  username?: string;
  /** Absent for 'oauth' (the OAuth service refreshes it) and 'gh' (asked of the GitHub CLI on each use). */
  token?: string;
  login: string;
  source: 'oauth' | 'token' | 'gh';
  connectedAt: number;
}

/** What the webview may know about a connection. */
export interface CodeHostConnectionSummary {
  id: string;
  kind: CodeHostKind;
  host: string;
  login: string;
  source: 'oauth' | 'token' | 'gh';
  warning?: string;
}
