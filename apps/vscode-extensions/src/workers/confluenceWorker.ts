// Import only types to avoid direct imports of ES Module
import type { ConfluencePage } from '@workspace-gpt/confluence-utils';
import { parentPort, workerData } from 'worker_threads';
// Import path for dynamic import
const CONFLUENCE_MODULE = '@workspace-gpt/confluence-utils';
import fs from 'fs';
import path from 'path';

interface WorkerData {
  spaceKey: string;
  confluenceBaseUrl: string;
  apiToken: string;
  userEmail: string;
}

// Receive data from main thread
const { spaceKey, confluenceBaseUrl, apiToken, userEmail } =
  workerData as WorkerData;

async function fetchAndProcessPages() {
  try {
    // Dynamically import the module - using Function constructor to prevent
    // TypeScript from transforming this to require() during transpilation
    const importModule = new Function(
      'modulePath',
      'return import(modulePath)'
    );
    const confluenceUtils = await importModule(CONFLUENCE_MODULE);
    const ConfluencePageFetcher = confluenceUtils.ConfluencePageFetcher;
    const processPage = confluenceUtils.processPage;
    const sleep = confluenceUtils.sleep;

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
    // parentPort?.postMessage({ type: 'totalPages', count: totalSize });

    // Fetch all pages
    let start = 0;
    let processedCount = 0;
    let hasMore = true;
    let allPages: ConfluencePage[] = [];
    try {
        // while (hasMore) {
        while (hasMore && false) {
          const response = await extractor.fetchPages(start, 10);
          const { results, size, _links } = response;
          allPages = allPages.concat(results);

          processedCount = await processPageBatch(
            results,
            processedCount,
            totalSize,
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
            type: 'progress',
            progress,
            current: processedCount,
            total: totalSize,
          });
        }
      
      // const pagesContext = fs.readFileSync(
      //   "/Users/ritesh/codebase/ritesh-codebase/workspaceGPT/.data/confluence/pages/confluence_pages.json",
      //   'utf8'
      // );
      // const allPages = JSON.parse(pagesContext) as ConfluencePage[];

      parentPort?.postMessage({ type: 'complete', pages: allPages });
    } catch (error) {
      parentPort?.postMessage({
        type: 'error',
        message: `Error processing page : ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      message: `Error in worker: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

interface ProcessedPage {
  filename: string;
  text: string;
  pageUrl?: string;
}

interface ExtractorConfig {
  outputDir: string;
  batchSize: number;
  rateLimit: number;
}

async function processPageBatch(
  pages: ConfluencePage[],
  processedCount: number,
  totalSize: number,
  processPage: (page: ConfluencePage) => ProcessedPage
): Promise<number> {
  let updatedCount = processedCount;

  for (const page of pages) {
    try {
      const processedPage = processPage(page) as ProcessedPage;

      if (processedPage.text.length > 60) {
        // Send each processed page back to the manager for saving
        parentPort?.postMessage({
          type: 'processedPage',
          page: processedPage
        });
        
        updatedCount++;
        console.log(
          `✅ Processed and sent page ${updatedCount}/${totalSize}: ${processedPage.filename}`
        );
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
