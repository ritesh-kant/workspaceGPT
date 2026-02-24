import { ConfluencePage, ProcessedPage } from '../types';
import { extractTextFromXML } from './xmlParser';

export function processPage(confluenceBaseUrl: string, page: ConfluencePage): ProcessedPage {
    const pageContent = page.body?.storage?.value ?? '';
    
    // In V2, _links.webui is a relative path (e.g. /spaces/XYZ/pages/123)
    let webui = page._links?.webui ?? '';
    if (webui && !webui.startsWith('/')) {
        webui = '/' + webui;
    }

    return {
        pageUrl: confluenceBaseUrl + webui,
        filename: page.title.replace(/[/\\:*?"<>|]/g, '_'),
        text: extractTextFromXML(pageContent)
    };
}