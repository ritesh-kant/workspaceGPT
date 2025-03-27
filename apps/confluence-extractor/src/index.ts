import path from 'path';
import fs from 'fs';
import {
  ConfluencePageFetcher,
  createFolders,
  processPage,
  sleep,
} from '@workspace-gpt/confluence-utils';

import {
  API_TOKEN,
  CONFLUENCE_BASE_URL,
  SPACE_KEY,
  USER_EMAIL,
} from './config.js';
import { ConfluencePage } from '@workspace-gpt/confluence-utils/src/index.js';

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
  outputDir: string,
  processedCount: number,
  totalSize: number
): Promise<number> {
  let updatedCount = processedCount;

  for (const page of pages) {
    try {
      const processedPage = processPage(page) as ProcessedPage;
      const outputFilePath = path.join(outputDir, `${processedPage.filename}.md`);

      if (processedPage.text.length > 60) {
        fs.writeFileSync(outputFilePath, processedPage.text, 'utf8');
        updatedCount++;
        console.log(
          `✅ Processed and saved page ${updatedCount}/${totalSize}: ${processedPage.filename}`
        );
      } else {
        console.log(`⚠️ Skipped page due to insufficient content: ${page.title}`);
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

async function main(): Promise<void> {
  try {
    const config: ExtractorConfig = {
      outputDir: path.resolve('../../.data/confluence/mds'),
      batchSize: 10,
      rateLimit: 1000, // milliseconds
    };

    // Create output directories
    createFolders([config.outputDir]);

    // Initialize page fetcher
    const extractor = new ConfluencePageFetcher(
      SPACE_KEY,
      CONFLUENCE_BASE_URL,
      API_TOKEN,
      USER_EMAIL,
      API_TOKEN
    );

    const totalSize = await extractor.getTotalPages();
    console.log('🚀 Starting Confluence page extraction...');
    console.log(`📚 Total pages to process: ${totalSize}`);

    let start = 0;
    let processedCount = 0;
    let hasMore = true;

    while (hasMore) {
      const response = await extractor.fetchPages(start, config.batchSize);
      const { results, size, _links } = response;

      processedCount = await processPageBatch(
        results,
        config.outputDir,
        processedCount,
        totalSize
      );

      if (!_links.next) {
        hasMore = false;
      } else {
        start += size;
        await sleep(config.rateLimit);
      }

      const progress = ((processedCount / totalSize) * 100).toFixed(1);
      console.log(`📊 Progress: ${progress}% (${processedCount}/${totalSize} pages)`);
    }

    console.log('✅ Extraction completed successfully!');
  } catch (error) {
    console.error(
      '❌ Extraction failed:',
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

// Run the application
main().catch((error) => {
  console.error(
    '❌ Unhandled error:',
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
