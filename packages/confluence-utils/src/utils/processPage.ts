import { ConfluencePage, ProcessedPage } from '../types';
import { extractTextFromXML } from './xmlParser';

/** The synced markdown's file name (without `.md`) for a page title. */
export function pageFilename(title: string): string {
    return title.replace(/[/\\:*?"<>|]/g, '_');
}

export function processPage(confluenceBaseUrl: string, page: ConfluencePage): ProcessedPage {
    const pageContent = page.body?.storage?.value ?? '';
    
    // In V2, _links.webui is a relative path (e.g. /spaces/XYZ/pages/123)
    let webui = page._links?.webui ?? '';
    if (webui && !webui.startsWith('/')) {
        webui = '/' + webui;
    }

    return {
        pageUrl: confluenceBaseUrl + webui,
        filename: pageFilename(page.title),
        text: extractTextFromXML(pageContent)
    };
}