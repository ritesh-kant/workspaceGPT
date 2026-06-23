export { ConfluencePageFetcher, type AuthMode } from './utils/fetchPages';
export { processPage } from './utils/processPage';

export { extractTextFromXML } from './utils/xmlParser';
export { parseStorageTables, type ParsedTable } from './utils/parseTables';
export { createFolders } from './utils/folderManager';
export { sleep } from './utils/sleep.js';

export type { ConfluencePage, ConfluencePageResponse, ProcessedPage } from './types';