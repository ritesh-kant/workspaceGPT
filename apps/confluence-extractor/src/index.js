
import { fileURLToPath } from "url";
import { fetchAllPages } from "./utils/fetchPages.js";
import { convertHtmlToPdf } from "./utils/puppeteer.js";
import fs from "fs";
import path from "path";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.basename(__filename);

(async () => {
    const CONFLUENCE_FILE_PATH = path.resolve(__dirname, "../../../data/confluence/pages", "confluence_pages.json")
    const OUTPUT_FOLDER_PATH = path.resolve(__dirname, "../../../data/confluence/pdfs")
    try {
        let pages = fetchPagesFromFile(CONFLUENCE_FILE_PATH);   // Check for local file first

        if (!pages?.length) {
            pages = await fetchAllPages();
            console.log("📝 Writing to confluence_pages.json...");
            fs.writeFileSync(CONFLUENCE_FILE_PATH, JSON.stringify(pages, null, 2), 'utf8');
        }

        console.log("📄 Fetched Pages:", pages.length);

        // Assuming you want to process each page and save it as a PDF
        await convertHtmlToPdf(pages, OUTPUT_FOLDER_PATH);
        
    } catch (error) {
        console.error("❌ Error:", error);
    }
})();

function fetchPagesFromFile(CONFLUENCE_FILE_PATH) {

    if (fs.existsSync(CONFLUENCE_FILE_PATH)) {   // Check if file exists
        console.log('📖 Reading from confluence_pages.json');

        const rawData = fs.readFileSync(CONFLUENCE_FILE_PATH, 'utf8');
        return JSON.parse(rawData);   // Return parsed data
    }

    return [];
}
