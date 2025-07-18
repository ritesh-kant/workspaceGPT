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
  confluenceBaseUrl: string;
  apiToken: string;
  userEmail: string;
  resume?: boolean;
  lastProcessedPageId?: string;
  processedPages?: number;
}

// Receive data from main thread
const {
  spaceKey,
  confluenceBaseUrl,
  apiToken,
  userEmail,
  resume,
  lastProcessedPageId,
  processedPages,
} = workerData as WorkerData;

async function fetchAndProcessPages() {
  try {
    // Create the page fetcher
    const extractor = new ConfluencePageFetcher(
      spaceKey,
      confluenceBaseUrl,
      apiToken,
      userEmail,
      apiToken
    );

    // Get total pages count
    const totalSize = await extractor.getTotalPages();
    parentPort?.postMessage({ type: 'totalPages', count: totalSize });

    // Fetch all pages
    let start = resume && processedPages ? processedPages : 0;
    let processedCount = resume && processedPages ? processedPages : 0;
    let hasMore = true;
    let allPages: ConfluencePage[] = [];
    let foundLastProcessedPage = !resume || !lastProcessedPageId;

    try {
      // while (hasMore && allPages.length < 30) {
      while (hasMore) {
        const response = await extractor.fetchPages(start, 10);
        const { results, size, _links } = response;

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
            start += size;
            if (!_links.next) {
              hasMore = false;
            }
            continue;
          }
        }

        allPages = allPages.concat(results);

        processedCount = await processPageBatch(
          results,
          processedCount,
          processPage
        );

        if (!_links.next) {
          hasMore = false;
        } else {
          start += size;
          await sleep(1000);
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
  processPage: (confluenceBaseUrl: string, page: ConfluencePage) => ProcessedPage
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
        // console.log(
        //   `✅ Processed and sent page ${updatedCount}/${totalSize}: ${processedPage.filename}`
        // );
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
