import { ConfluencePage, ProcessedPage } from '../types';
import { extractTextFromXML } from './xmlParser';

export function processPage(confluenceBaseUrl: string, page: ConfluencePage): ProcessedPage {
    const pageContent = page.body?.storage.value ?? '';

    return {
        pageUrl: confluenceBaseUrl + (page._links?.webui ?? ''),
        filename: page.title.replace(/[/\\:*?"<>|]/g, '_'),
        text: extractTextFromXML(pageContent)
    };
}