import puppeteer from 'puppeteer';
import path from 'path';
import { CONFLUENCE_BASE_URL } from '../config.js';

export async function convertHtmlToPdf(pages, outputFolder) {
    const browser = await puppeteer.launch();
    let count = 1
    for (const page of pages) {
        const PAGE_URL = CONFLUENCE_BASE_URL + page._links.webui;
        const htmlContent = page.body.storage.value; // Simplified assumption, actual content might be different
        const browserPage = await browser.newPage();
        await browserPage.setContent(htmlContent, { waitUntil: "load" });
        const footerHtml = `
        <div style="position: absolute; bottom: 0; left: 0; width: 100%; text-align: center; font-size: 10px; color: grey;">
          <p>Confluence Page URL: <a href="${PAGE_URL}" target="_blank">${PAGE_URL}</a></p>
        </div>
      `;
        const safeTitle = page.title.replace(/[^a-zA-Z0-9]/g, "_");
        const pdfPath = path.join(outputFolder, `${safeTitle}.pdf`);
        await browserPage.pdf({
            path: pdfPath, 
            format: "A4", 
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: '',
            footerTemplate: footerHtml,  // Custom footer with URL

        });
        console.log(`✅ PDF saved count ${count++}: ${pdfPath}`);
        await browserPage.close();
    }
    await browser.close();

}