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

    // Get total pages count
    const totalSize = await extractor.getTotalPages();
    parentPort?.postMessage({ type: 'totalPages', count: totalSize });

    // Fetch all pages
    let cursor: string | null = null;
    let processedCount = resume && processedPages ? processedPages : 0;
    let hasMore = true;
    let allPages: ConfluencePage[] = [];
    let foundLastProcessedPage = !resume || !lastProcessedPageId;

    try {
      while (hasMore) {
        const response = await extractor.fetchPages(cursor, 50); // Increased limit slightly for v2
        const { results, _links } = response;

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
            if (_links && _links.next) {
              const url = new URL(`https://api.atlassian.com${_links.next}`);
              cursor = url.searchParams.get('cursor');
            } else {
              hasMore = false;
            }
            continue;
          }
        }

        allPages = allPages.concat(results);

        processedCount = await processPageBatch(
          results,
          processedCount,
          processPage,
          confluenceBaseUrl
        );

        if (_links && _links.next) {
            // Extract the cursor from the relative next link
            // /wiki/api/v2/spaces/.../pages?cursor=XXXXX
            const nextUrl = new URL(`https://api.atlassian.com${_links.next}`);
            cursor = nextUrl.searchParams.get('cursor');
            await sleep(1000);
        } else {
            hasMore = false;
        }

        const progress = ((processedCount / totalSize) * 100).toFixed(1);
        console.log(
          `📊 Progress: ${progress}% (${processedCount}/${totalSize} pages)`
        );
        parentPort?.postMessage({
          type: WORKER_STATUS.PROCESSING,
          progress,
          current: processedCount,
          total: totalSize,
          lastProcessedPageId: results[results.length - 1]?.id,
        });
      }

      parentPort?.postMessage({
        type: WORKER_STATUS.COMPLETED,
        pages: allPages,
      });
    } catch (error) {
      parentPort?.postMessage({
        type: WORKER_STATUS.ERROR,
        message: `Error processing page : ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } catch (error) {
    parentPort?.postMessage({
      type: WORKER_STATUS.ERROR,
      message: `Error in worker: ${error instanceof Error ? error.message : String(error)}`,
    });
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
