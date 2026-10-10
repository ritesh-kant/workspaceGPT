/** Shared host/webview contract. Activity stays on-device. */
export interface HomePullRequest {
  id: string;
  number: string;
  title: string;
  url: string;
  source: 'ado' | 'github' | 'gitlab' | 'bitbucket';
  repository: string;
  author: string;
  updatedAt: string;
  revision: string;
  ownership: 'review' | 'mine';
  state: 'review-requested' | 'awaiting-review' | 'changes-requested' | 'approved' | 'draft';
}

export interface HomeMention {
  id: string;
  title: string;
  url: string;
  source: 'ado' | 'jira' | 'confluence';
  author: string;
  excerpt: string;
  updatedAt: string;
  revision: string;
  /** Search results identify content, not necessarily the original mention author. */
  contentType?: 'page' | 'comment';
}

export interface HomeSection<T> {
  items: T[];
  error?: string;
  setup?: string;
  /** A bounded recent-activity query, rather than a complete notification inbox. */
  coverage?: string;
  limited?: boolean;
}

export interface HomeActivity {
  pullRequests: HomeSection<HomePullRequest>;
  trackerMentions: HomeSection<HomeMention>;
  confluenceMentions: HomeSection<HomeMention>;
}

export const HOME_ACTIVITY_MESSAGES = {
  get: 'get-home-activity',
  response: 'home-activity-response',
  seen: 'home-activity-seen',
} as const;

export function hasJiraMention(node: any, accountId: string): boolean {
  if (!node || !accountId) return false;
  if (node.type === 'mention' && node.attrs?.id === accountId) return true;
  return Array.isArray(node.content) && node.content.some((child: any) => hasJiraMention(child, accountId));
}

export function adfText(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return String(node.text ?? '');
  if (node.type === 'mention') return String(node.attrs?.text ?? '');
  return (node.content ?? []).map(adfText).join(node.type === 'doc' ? ' ' : '');
}

/** Votes are review state; reading the PR never changes them. */
export function adoReviewState(reviewers: any[], draft: boolean): HomePullRequest['state'] {
  if (draft) return 'draft';
  const votes = reviewers.map((r) => Number(r.vote ?? 0));
  if (votes.some((vote) => vote < 0)) return 'changes-requested';
  const required = reviewers.filter((r) => r.isRequired);
  if (votes.some((vote) => vote > 0) && required.every((r) => Number(r.vote) > 0)) return 'approved';
  return 'awaiting-review';
}
