import { ConfluencePage, ProcessedPage } from '../types';
import { extractTextFromXML } from './xmlParser';

export function processPage(page: ConfluencePage): ProcessedPage {
    const pageContent = page.body?.storage.value ?? '';

    return {
        pageUrl: (page._links?.self ?? "") + (page._links?.webui ?? ''),
        filename: page.title.replace(/[/\\:*?"<>|]/g, '_'),
        text: extractTextFromXML(pageContent)
    };
}