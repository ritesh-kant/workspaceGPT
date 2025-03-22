import { parentPort, workerData } from 'worker_threads';
import { ConfluencePageFetcher, processPage } from '@workspace-gpt/confluence-utils';

interface WorkerData {
  spaceKey: string;
  confluenceBaseUrl: string;
  apiToken: string;
  userEmail: string;
}

// Receive data from main thread
const { spaceKey, confluenceBaseUrl, apiToken, userEmail } = workerData as WorkerData;

async function fetchAndProcessPages() {
  try {
    // Create the page fetcher
    const extractor = new ConfluencePageFetcher(spaceKey, confluenceBaseUrl, apiToken, userEmail, apiToken);
    
    // Get total pages count
    const totalSize = await extractor.getTotalPages();
    parentPort?.postMessage({ type: 'totalPages', count: totalSize });
    
    // Fetch all pages
    const pages = await extractor.fetchPages();
    parentPort?.postMessage({ type: 'pagesFetched', count: pages.length });
    
    // Process pages and send progress updates
    const processedPages = [];
    for (const [index, page] of pages.entries()) {
      try {
        const processedPage = processPage(page);
        
        // Only add pages with sufficient content
        if (processedPage.text.length > 60) {
          processedPages.push({
            title: processedPage.filename,
            url: processedPage.pageUrl,
            content: processedPage.text
          });
        }
        
        // Calculate and send progress
        const progress = Math.round(((index + 1) / pages.length) * 100);
        parentPort?.postMessage({ type: 'progress', progress, current: index + 1, total: pages.length });
      } catch (error) {
        parentPort?.postMessage({ 
          type: 'error', 
          message: `Error processing page ${page.title}: ${error instanceof Error ? error.message : String(error)}` 
        });
      }
    }
    
    // Send the final result
    parentPort?.postMessage({ type: 'complete', pages: processedPages });
  } catch (error) {
    parentPort?.postMessage({ 
      type: 'error', 
      message: `Error in worker: ${error instanceof Error ? error.message : String(error)}` 
    });
  }
}

// Start the process
fetchAndProcessPages();