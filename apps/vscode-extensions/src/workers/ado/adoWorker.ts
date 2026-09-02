import { parentPort, workerData } from 'worker_threads';
import { WORKER_STATUS } from '../../../constants';

interface WorkerData {
  orgName: string;
  projectName: string;
  authHeader: string;           // Pre-built `Basic`/`Bearer` Authorization value
  resume?: boolean;
  lastProcessedId?: string;
  processedItems?: number;
  isIncremental?: boolean;
  lastSyncTime?: string;
  lookbackMonths?: number;
}

interface WorkItem {
  id: number;
  url: string;
}

interface WorkItemDetail {
  id: number;
  fields: {
    'System.Title': string;
    'System.WorkItemType': string;
    'System.State': string;
    'System.Description'?: string;
    'Microsoft.VSTS.Common.AcceptanceCriteria'?: string;
    'System.Tags'?: string;
    'System.AssignedTo'?: { displayName: string };
    'System.IterationPath'?: string;
    'Microsoft.VSTS.Common.Priority'?: number;
    'System.ChangedDate'?: string;
    'System.CreatedDate'?: string;
    'System.CommentCount'?: number;
    'System.AreaPath'?: string;
  };
  _links?: { html?: { href: string } };
}

interface Comment {
  text: string;
  createdBy?: { displayName: string };
  createdDate?: string;
}

const {
  orgName,
  projectName,
  resume,
  lastProcessedId,
  processedItems,
  isIncremental,
  lastSyncTime,
  lookbackMonths,
} = workerData as WorkerData;

// Mutable: the sync can run well past a Bearer token's ~60-90min TTL (MSAL/Azure
// CLI auth modes), so AdoService pushes a refreshed header periodically via
// postMessage rather than this being frozen for the worker's whole lifetime.
let authHeader = (workerData as WorkerData).authHeader;

parentPort?.on('message', (msg: any) => {
  if (msg?.type === 'refresh-auth' && typeof msg.authHeader === 'string') {
    authHeader = msg.authHeader;
  }
});

const lookbackDays = (lookbackMonths || 24) * 30;

const baseUrl = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(projectName)}/_apis`;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

/** Fetch + parse JSON with a request timeout and retry/backoff on 429/5xx. */
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
      throw new Error(`ADO request failed after ${MAX_RETRIES + 1} attempts: ${lastError.message}`);
    }

    if (response.ok) {
      return response.json();
    }

    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
      await sleep(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : backoffMs(attempt));
      continue;
    }

    const text = await response.text();
    throw new Error(`ADO API error (${response.status}): ${text.substring(0, 200)}`);
  }

  throw lastError ?? new Error('ADO request failed');
}

async function adoFetch(url: string): Promise<any> {
  return requestJson(url, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  });
}

async function adoPost(url: string, body: any): Promise<any> {
  return requestJson(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Runs `fn` over `items` with at most `limit` in flight; results preserve input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
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

async function fetchWorkItemIds(): Promise<number[]> {
  let wiqlQuery = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${projectName}' AND [System.ChangedDate] >= @today - ${lookbackDays}`;

  if (isIncremental && lastSyncTime) {
    const dateOnly = lastSyncTime.split('T')[0];
    wiqlQuery += ` AND [System.ChangedDate] >= '${dateOnly}'`;
  }

  wiqlQuery += ' ORDER BY [System.ChangedDate] DESC';

  const wiqlUrl = `${baseUrl}/wit/wiql?api-version=7.1&$top=20000`;
  const result = await adoPost(wiqlUrl, { query: wiqlQuery });
  return (result.workItems as WorkItem[]).map(wi => wi.id);
}

async function fetchWorkItemDetails(ids: number[]): Promise<WorkItemDetail[]> {
  const fields = [
    'System.Id',
    'System.Title',
    'System.WorkItemType',
    'System.State',
    'System.Description',
    'Microsoft.VSTS.Common.AcceptanceCriteria',
    'System.Tags',
    'System.AssignedTo',
    'System.IterationPath',
    'Microsoft.VSTS.Common.Priority',
    'System.ChangedDate',
    'System.CreatedDate',
    'System.CommentCount',
    'System.AreaPath',
  ];

  const url = `${baseUrl}/wit/workitemsbatch?api-version=7.1`;
  const result = await adoPost(url, { ids, fields });
  return result.value as WorkItemDetail[];
}

async function fetchComments(workItemId: number): Promise<Comment[]> {
  try {
    const url = `${baseUrl}/wit/workItems/${workItemId}/comments?api-version=7.1-preview.3`;
    const result = await adoFetch(url);
    return (result.comments || []) as Comment[];
  } catch {
    return []; // Comments are optional - don't fail the sync
  }
}

function workItemToMarkdown(item: WorkItemDetail, comments: Comment[]): string {
  const f = item.fields;
  const htmlUrl = item._links?.html?.href || `https://dev.azure.com/${orgName}/${projectName}/_workitems/edit/${item.id}`;

  const lines: string[] = [
    `# [${f['System.WorkItemType']} #${item.id}] ${f['System.Title']}`,
    '',
    `| Field | Value |`,
    `|-------|-------|`,
    `| **Status** | ${f['System.State']} |`,
    `| **Type** | ${f['System.WorkItemType']} |`,
    `| **Assigned To** | ${f['System.AssignedTo']?.displayName || 'Unassigned'} |`,
    `| **Priority** | ${f['Microsoft.VSTS.Common.Priority'] ?? 'N/A'} |`,
    `| **Sprint** | ${f['System.IterationPath'] || 'N/A'} |`,
    `| **Area** | ${f['System.AreaPath'] || 'N/A'} |`,
    `| **Tags** | ${f['System.Tags'] || 'None'} |`,
    `| **Created** | ${f['System.CreatedDate'] ? new Date(f['System.CreatedDate']).toLocaleDateString() : 'N/A'} |`,
    `| **Updated** | ${f['System.ChangedDate'] ? new Date(f['System.ChangedDate']).toLocaleDateString() : 'N/A'} |`,
    `| **URL** | [Open in ADO](${htmlUrl}) |`,
    '',
  ];

  if (f['System.Description']) {
    const cleanDescription = f['System.Description']
      .replace(/<[^>]+>/g, '') // Strip HTML tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    if (cleanDescription) {
      lines.push('## Description', '', cleanDescription, '');
    }
  }

  if (f['Microsoft.VSTS.Common.AcceptanceCriteria']) {
    const cleanCriteria = f['Microsoft.VSTS.Common.AcceptanceCriteria']
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (cleanCriteria) {
      lines.push('## Acceptance Criteria', '', cleanCriteria, '');
    }
  }

  if (comments.length > 0) {
    lines.push('## Comments', '');
    for (const comment of comments) {
      const author = comment.createdBy?.displayName || 'Unknown';
      const date = comment.createdDate
        ? new Date(comment.createdDate).toLocaleDateString()
        : '';
      const cleanText = (comment.text || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim();
      lines.push(`**${author}** (${date}):`, cleanText, '');
    }
  }

  return lines.join('\n');
}

async function fetchAndProcessAdoItems() {
  try {
    console.log(`🚀 Starting ADO Sync for project "${projectName}" in org "${orgName}"`);
    if (isIncremental && lastSyncTime) {
      console.log(`📅 Incremental sync from ${lastSyncTime}`);
    }

    // Step 1: Fetch all matching work item IDs via WIQL
    const allIds = await fetchWorkItemIds();
    const totalItems = allIds.length;
    console.log(`📋 Found ${totalItems} work items to sync`);

    if (totalItems === 0) {
      parentPort?.postMessage({
        type: WORKER_STATUS.COMPLETED,
        itemsCount: 0,
      });
      return;
    }

    // Step 2: Resume support — skip already processed IDs
    let startIndex = 0;
    if (resume && processedItems && processedItems > 0) {
      startIndex = processedItems;
      console.log(`⏭ Resuming from item ${startIndex}`);
    }

    let processedCount = startIndex;

    // Step 3: Process in batches of 200 (ADO API limit)
    const BATCH_SIZE = 200;
    const COMMENT_FETCH_CONCURRENCY = 8;
    const idsToProcess = allIds.slice(startIndex);

    for (let batchOffset = 0; batchOffset < idsToProcess.length; batchOffset += BATCH_SIZE) {
      const batchIds = idsToProcess.slice(batchOffset, batchOffset + BATCH_SIZE);
      const details = await fetchWorkItemDetails(batchIds);

      // Comments are fetched concurrently (order preserved) — sequential
      // one-at-a-time fetches were the main reason large syncs ran long
      // enough to outlive a Bearer token's TTL.
      const commentsByItem = await mapWithConcurrency(details, COMMENT_FETCH_CONCURRENCY, (item) =>
        (item.fields['System.CommentCount'] ?? 0) > 0 ? fetchComments(item.id) : Promise.resolve([])
      );

      for (let i = 0; i < details.length; i++) {
        const item = details[i];
        const comments = commentsByItem[i];

        const markdownContent = workItemToMarkdown(item, comments);
        const htmlUrl = item._links?.html?.href ||
          `https://dev.azure.com/${orgName}/${projectName}/_workitems/edit/${item.id}`;
        const filename = `ADO-${item.id}`;

        parentPort?.postMessage({
          type: WORKER_STATUS.PROCESSED,
          item: {
            filename,
            text: markdownContent,
            url: htmlUrl,
          },
        });

        processedCount++;

        const progressPercent = ((processedCount / totalItems) * 100).toFixed(1);
        
        // Log progress every 50 items or on the last item to avoid overly noisy logs
        if (processedCount % 50 === 0 || processedCount === totalItems) {
            console.log(`📊 ADO Progress: ${progressPercent}% (${processedCount}/${totalItems} items)`);
        }

        parentPort?.postMessage({
          type: WORKER_STATUS.PROCESSING,
          progress: progressPercent,
          current: processedCount,
          total: totalItems,
          lastProcessedId: filename,
        });
      }
    }

    parentPort?.postMessage({
      type: WORKER_STATUS.COMPLETED,
      itemsCount: processedCount,
    });
  } catch (error) {
    parentPort?.postMessage({
      type: WORKER_STATUS.ERROR,
      message: `Error in ADO worker: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

fetchAndProcessAdoItems();
