// Import only types to avoid direct imports of ES Module
import type { ConfluencePage } from '@workspace-gpt/confluence-utils';
import { parentPort, workerData } from 'worker_threads';
import { WORKER_STATUS } from '../../../constants';
// Import path for dynamic import
import {
  ConfluencePageFetcher,
  processPage,
  sleep,
} from '@workspace-gpt/confluence-utils';

interface WorkerData {
  spaceKey: string;
  cloudId: string;
  accessToken: string;
  authMode: 'oauth' | 'basic';
  resume?: boolean;
  lastProcessedPageId?: string;
  processedPages?: number;
  isIncremental?: boolean;
  lastSyncTime?: string;
}

// Receive data from main thread
const {
  spaceKey,
  cloudId,
  accessToken,
  authMode,
  resume,
  lastProcessedPageId,
  processedPages,
  isIncremental,
  lastSyncTime,
} = workerData as WorkerData;

async function fetchAndProcessPages() {
  try {
    // Create the page fetcher with OAuth mode
    const extractor = new ConfluencePageFetcher(
      spaceKey,
      cloudId,
      accessToken,
      '', // userEmail not needed for OAuth
      accessToken,
      authMode
    );

    // For OAuth, derive a base URL for processPage (used for building page URLs)
    const confluenceBaseUrl = `https://api.atlassian.com/ex/confluence/${cloudId}`;

    const limit = 50;
    let processedCount = resume && processedPages ? processedPages : 0;
    let allPages: ConfluencePage[] = [];

    if (isIncremental && lastSyncTime) {
      console.log(`🚀 Starting Incremental Sync for pages updated since ${lastSyncTime}`);
      allPages = await doIncrementalSync(extractor, confluenceBaseUrl, limit, lastSyncTime, processedCount);
    } else {
      console.log(`🚀 Starting Full Sync`);
      allPages = await doFullSync(extractor, confluenceBaseUrl, limit, processedCount);
    }

    parentPort?.postMessage({
      type: WORKER_STATUS.COMPLETED,
      pages: allPages,
    });
  } catch (error) {
    parentPort?.postMessage({
      type: WORKER_STATUS.ERROR,
      message: `Error in worker: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function doIncrementalSync(
  extractor: ConfluencePageFetcher,
  confluenceBaseUrl: string,
  limit: number,
  lastSyncTime: string,
  initialProcessedCount: number
): Promise<ConfluencePage[]> {
  let hasMore = true;
  let incrementalStart = 0;
  let allPages: ConfluencePage[] = [];
  let processedCount: number = initialProcessedCount;

  try {
    while (hasMore) {
      // Use the V1 search API to find pages modified since last sync
      const searchResponse = await extractor.fetchRecentPagesSince(lastSyncTime, limit, incrementalStart);
      const totalSize = searchResponse.size;
      
      if (incrementalStart === 0 && totalSize > 0) {
        parentPort?.postMessage({ type: 'totalPages', count: totalSize });
      } else if (incrementalStart === 0 && totalSize === 0) {
        parentPort?.postMessage({ type: 'totalPages', count: 0 });
        hasMore = false;
        break;
      }

      // Search results from v1 don't include the full body, we need to fetch them individually via v2
      const pagePromises = searchResponse.results.map((searchResult: any) => 
        extractor.fetchPageById(searchResult.content?.id || searchResult.id)
          .catch(err => {
            console.warn(`Failed to fetch page ${searchResult.id} during incremental sync:`, err);
            return null;
          })
      );
      
      const results = (await Promise.all(pagePromises)).filter(p => p !== null) as ConfluencePage[];
      allPages = allPages.concat(results);

      processedCount = await processPageBatch(
        results,
        processedCount,
        processPage,
        confluenceBaseUrl
      );

      const progress = totalSize > 0 ? ((processedCount / totalSize) * 100).toFixed(1) : "100.0";
      console.log(`📊 Progress: ${progress}% (${processedCount}/${totalSize} pages)`);
      
      parentPort?.postMessage({
        type: WORKER_STATUS.PROCESSING,
        progress,
        current: processedCount,
        total: totalSize,
        lastProcessedPageId: results[results.length - 1]?.id,
      });

      if (searchResponse.results.length === limit) {
         incrementalStart += limit;
         // Add artificial delay for pagination
         await sleep(1000);
      } else {
         hasMore = false;
      }
    }
    return allPages;
  } catch (error) {
    parentPort?.postMessage({
      type: WORKER_STATUS.ERROR,
      message: `Error processing incremental sync page: ${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  }
}

async function doFullSync(
  extractor: ConfluencePageFetcher,
  confluenceBaseUrl: string,
  limit: number,
  initialProcessedCount: number
): Promise<ConfluencePage[]> {
  let cursor: string | null = null;
  let hasMore = true;
  let allPages: ConfluencePage[] = [];
  let foundLastProcessedPage = !resume || !lastProcessedPageId;
  let processedCount: number = initialProcessedCount;

  try {
    const totalSize = await extractor.getTotalPages().catch(() => 0);
    parentPort?.postMessage({ type: 'totalPages', count: totalSize });

    while (hasMore) {
      let results: ConfluencePage[] = [];
      let nextLink: string | null = null;

      const response = await extractor.fetchPages(cursor, limit);
      results = response.results;
      
      if (response._links && response._links.next) {
        nextLink = response._links.next;
      }

      // If resuming, skip pages until we find the last processed page
      if (resume && lastProcessedPageId && !foundLastProcessedPage) {
        const lastProcessedIndex = results.findIndex(
          (page) => page.id === lastProcessedPageId
        );
        if (lastProcessedIndex !== -1) {
          // Skip the last processed page and all previous pages
          results.splice(0, lastProcessedIndex + 1);
          foundLastProcessedPage = true;
        } else {
          // If we haven't found the last processed page yet, skip this batch
          if (nextLink) {
            const url = new URL(`https://api.atlassian.com${nextLink}`);
            cursor = url.searchParams.get('cursor');
          } else {
            hasMore = false;
          }
          continue; // Skip the rest of the loop for this batch
        }
      }

      if (nextLink) {
          const nextUrl = new URL(`https://api.atlassian.com${nextLink}`);
          cursor = nextUrl.searchParams.get('cursor');
          await sleep(1000);
      } else {
          hasMore = false;
      }

      allPages = allPages.concat(results);

      processedCount = await processPageBatch(
        results,
        processedCount,
        processPage,
        confluenceBaseUrl
      );

      const progress = totalSize > 0 ? ((processedCount / totalSize) * 100).toFixed(1) : "100.0";
      console.log(`📊 Progress: ${progress}% (${processedCount}/${totalSize} pages)`);
      
      parentPort?.postMessage({
        type: WORKER_STATUS.PROCESSING,
        progress,
        current: processedCount,
        total: totalSize,
        lastProcessedPageId: results[results.length - 1]?.id,
      });
    }
    return allPages;
  } catch (error) {
    parentPort?.postMessage({
      type: WORKER_STATUS.ERROR,
      message: `Error processing full sync page: ${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  }
}

interface ProcessedPage {
  filename: string;
  text: string;
  pageUrl?: string;
}

async function processPageBatch(
  pages: ConfluencePage[],
  processedCount: number,
  processPage: (confluenceBaseUrl: string, page: ConfluencePage) => ProcessedPage,
  confluenceBaseUrl: string
): Promise<number> {
  let updatedCount = processedCount;

  for (const page of pages) {
    try {
      const processedPage = processPage(confluenceBaseUrl, page) as ProcessedPage;

      if (processedPage.text.length > 60) {
        // Send each processed page back to the manager for saving
        parentPort?.postMessage({
          type: WORKER_STATUS.PROCESSED,
          page: processedPage,
        });

        updatedCount++;
      } else {
        console.log(
          `⚠️ Skipped page due to insufficient content: ${page.title}`
        );
      }
    } catch (error) {
      console.warn(
        `⚠️ Error processing page ${page.title}:`,
        error instanceof Error ? error.message : String(error)
      );
      // Continue processing other pages instead of exiting
    }
  }

  return updatedCount;
}

// Start the process
fetchAndProcessPages();
