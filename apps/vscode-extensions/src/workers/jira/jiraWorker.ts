import { parentPort, workerData } from 'worker_threads';
import { WORKER_STATUS } from '../../../constants';
import { adfToText } from '../../services/jira/adf';

/**
 * Bulk sync — docs/design/jira.md §5 P5, the JQL/search-jql
 * counterpart to adoWorker.ts's WIQL/workitemsbatch. No vscode/host imports
 * here (matching adoWorker.ts): this runs in a worker_thread, and the auth
 * header is built host-side and passed in via workerData, exactly like
 * ADO's. adf.ts has no vscode import either, so it bundles into this worker
 * cleanly (see esbuild.config.js's workersConfig — each file under
 * src/workers/ is its own bundled entry point).
 *
 * UNVERIFIED against a live Jira instance (design doc §8 risk 2): this
 * assumes `/rest/api/3/search/jql` (POST, `nextPageToken` pagination) is the
 * current supported search endpoint, superseding the deprecated GET
 * `/rest/api/3/search`. If pagination behaves differently in practice, this
 * file is where that surfaces.
 */

interface WorkerData {
  /** The site's real domain — used only for the synced markdown's `/browse/{key}` urls. */
  siteUrl: string;
  /** `https://api.atlassian.com/ex/jira/{cloudId}` — every REST call in this worker goes here, not siteUrl. */
  apiBase: string;
  projectKey: string;
  authHeader: string; // Pre-built `Bearer` Authorization value (OAuth 3LO)
  resume?: boolean;
  lastProcessedId?: string;
  processedItems?: number;
  isIncremental?: boolean;
  lastSyncTime?: string;
  lookbackMonths?: number;
}

interface IssueFields {
  summary: string;
  issuetype: { name: string };
  status: { name: string };
  description?: unknown; // ADF
  labels?: string[];
  assignee?: { displayName: string };
  priority?: { name: string };
  created?: string;
  updated?: string;
  parent?: { key: string };
  project?: { name: string };
  comment?: { total: number };
}

interface Issue {
  key: string;
  fields: IssueFields;
}

interface JiraComment {
  author?: { displayName: string };
  created?: string;
  body: unknown; // ADF
}

const { siteUrl, apiBase, projectKey, resume, lastProcessedId, processedItems, isIncremental, lastSyncTime, lookbackMonths } =
  workerData as WorkerData;

// Mutable for the same reason adoWorker.ts's is: a sync can run well past a
// token's lifetime, and JiraService pushes a refreshed header periodically.
let authHeader = (workerData as WorkerData).authHeader;

parentPort?.on('message', (msg: any) => {
  if (msg?.type === 'refresh-auth' && typeof msg.authHeader === 'string') {
    authHeader = msg.authHeader;
  }
});

const lookbackDays = (lookbackMonths || 24) * 30;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

/** Fetch + parse JSON with a request timeout and retry/backoff on 429/5xx, honouring Retry-After. */
async function requestJson(url: string, init: RequestInit): Promise<any> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: authHeader },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new Error(`Jira request failed after ${MAX_RETRIES + 1} attempts: ${lastError.message}`);
    }

    if (response.ok) {
      return response.json();
    }

    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      // Jira Cloud's rate limits are tighter than ADO's and the header is
      // authoritative — trust it over the exponential backoff when present.
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
      await sleep(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : backoffMs(attempt));
      continue;
    }

    const text = await response.text();
    throw new Error(`Jira API error (${response.status}): ${text.substring(0, 200)}`);
  }

  throw lastError ?? new Error('Jira request failed');
}

async function jiraGet(url: string): Promise<any> {
  return requestJson(url, { headers: { Accept: 'application/json' } });
}

async function jiraPost(url: string, body: any): Promise<any> {
  return requestJson(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Runs `fn` over `items` with at most `limit` in flight; results preserve input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const current = cursor++;
      results[current] = await fn(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

const ISSUE_FIELDS = [
  'summary',
  'issuetype',
  'status',
  'description',
  'labels',
  'assignee',
  'priority',
  'created',
  'updated',
  'parent',
  'project',
  'comment',
];

function buildJql(): string {
  let jql = `project = "${projectKey}" AND updated >= -${lookbackDays}d`;
  if (isIncremental && lastSyncTime) {
    const dateOnly = lastSyncTime.split('T')[0];
    jql += ` AND updated >= "${dateOnly}"`;
  }
  jql += ' ORDER BY updated DESC';
  return jql;
}

/**
 * All matching issues, full fields inline — `search/jql` returns fields with
 * the search results themselves, unlike ADO's WIQL-then-workitemsbatch
 * two-step. Paginates via `nextPageToken` until `isLast`.
 */
async function fetchAllIssues(): Promise<Issue[]> {
  const jql = buildJql();
  const issues: Issue[] = [];
  let nextPageToken: string | undefined;

  for (;;) {
    const result = await jiraPost(`${apiBase}/rest/api/3/search/jql`, {
      jql,
      maxResults: 100,
      fields: ISSUE_FIELDS,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    issues.push(...((result.issues as Issue[]) ?? []));
    if (result.isLast !== false || !result.nextPageToken) break;
    nextPageToken = result.nextPageToken;
  }

  return issues;
}

async function fetchComments(key: string): Promise<JiraComment[]> {
  try {
    const url = `${apiBase}/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=50&orderBy=-created`;
    const result = await jiraGet(url);
    return (result.comments ?? []) as JiraComment[];
  } catch {
    return []; // Comments are optional — don't fail the sync
  }
}

function issueToMarkdown(issue: Issue, comments: JiraComment[]): string {
  const f = issue.fields;
  const htmlUrl = `${siteUrl}/browse/${issue.key}`;

  const lines: string[] = [
    `# [${f.issuetype?.name ?? 'Issue'} ${issue.key}] ${f.summary}`,
    '',
    `| Field | Value |`,
    `|-------|-------|`,
    `| **Status** | ${f.status?.name ?? 'Unknown'} |`,
    `| **Type** | ${f.issuetype?.name ?? 'Issue'} |`,
    `| **Assigned To** | ${f.assignee?.displayName || 'Unassigned'} |`,
    `| **Priority** | ${f.priority?.name ?? 'N/A'} |`,
    `| **Project** | ${f.project?.name ?? 'N/A'} |`,
    `| **Labels** | ${f.labels?.length ? f.labels.join(', ') : 'None'} |`,
    `| **Created** | ${f.created ? new Date(f.created).toLocaleDateString() : 'N/A'} |`,
    `| **Updated** | ${f.updated ? new Date(f.updated).toLocaleDateString() : 'N/A'} |`,
    `| **URL** | [Open in Jira](${htmlUrl}) |`,
    '',
  ];

  if (f.description) {
    const description = adfToText(f.description);
    if (description) {
      lines.push('## Description', '', description, '');
    }
  }

  if (comments.length > 0) {
    lines.push('## Comments', '');
    for (const comment of comments) {
      const author = comment.author?.displayName || 'Unknown';
      const date = comment.created ? new Date(comment.created).toLocaleDateString() : '';
      const text = adfToText(comment.body);
      lines.push(`**${author}** (${date}):`, text, '');
    }
  }

  return lines.join('\n');
}

async function fetchAndProcessJiraItems() {
  try {
    console.log(`🚀 Starting Jira sync for project "${projectKey}"`);
    if (isIncremental && lastSyncTime) {
      console.log(`📅 Incremental sync from ${lastSyncTime}`);
    }

    const allIssues = await fetchAllIssues();
    const totalItems = allIssues.length;
    console.log(`📋 Found ${totalItems} issues to sync`);

    if (totalItems === 0) {
      parentPort?.postMessage({ type: WORKER_STATUS.COMPLETED, itemsCount: 0 });
      return;
    }

    let startIndex = 0;
    if (resume && processedItems && processedItems > 0) {
      startIndex = processedItems;
      console.log(`⏭ Resuming from item ${startIndex}`);
    }

    let processedCount = startIndex;
    const COMMENT_FETCH_CONCURRENCY = 8;
    const issuesToProcess = allIssues.slice(startIndex);

    // Comments are fetched concurrently (order preserved), same reasoning as
    // adoWorker.ts's mapWithConcurrency: sequential one-at-a-time fetches were
    // the main reason a large ADO sync ran long enough to outlive a token.
    const commentsByIssue = await mapWithConcurrency(issuesToProcess, COMMENT_FETCH_CONCURRENCY, (issue) =>
      (issue.fields.comment?.total ?? 0) > 0 ? fetchComments(issue.key) : Promise.resolve([])
    );

    for (let i = 0; i < issuesToProcess.length; i++) {
      const issue = issuesToProcess[i];
      const comments = commentsByIssue[i];

      const markdownContent = issueToMarkdown(issue, comments);
      const htmlUrl = `${siteUrl}/browse/${issue.key}`;
      const filename = `JIRA-${issue.key}`;

      parentPort?.postMessage({
        type: WORKER_STATUS.PROCESSED,
        item: { filename, text: markdownContent, url: htmlUrl },
      });

      processedCount++;
      const progressPercent = ((processedCount / totalItems) * 100).toFixed(1);
      if (processedCount % 50 === 0 || processedCount === totalItems) {
        console.log(`📊 Jira progress: ${progressPercent}% (${processedCount}/${totalItems} items)`);
      }

      parentPort?.postMessage({
        type: WORKER_STATUS.PROCESSING,
        progress: progressPercent,
        current: processedCount,
        total: totalItems,
        lastProcessedId: filename,
      });
    }

    parentPort?.postMessage({ type: WORKER_STATUS.COMPLETED, itemsCount: processedCount });
  } catch (error) {
    parentPort?.postMessage({
      type: WORKER_STATUS.ERROR,
      message: `Error in Jira worker: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

fetchAndProcessJiraItems();
