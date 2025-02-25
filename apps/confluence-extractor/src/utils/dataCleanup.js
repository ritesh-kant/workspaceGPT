import fs from "fs";
import { processPages } from "./batchProcessor.js";
import { convertHtmlToPdf } from "./puppeteer.js";
import { ACTIVE_APP_MODE, APP_MODES } from "../config.js";

export async function processAllPDFs(pages, OUTPUT_MD_DIR, OUTPUT_PDF_DIR) {

    try {
        if(ACTIVE_APP_MODE === APP_MODES.LITE){
            await convertHtmlToPdf(pages, OUTPUT_PDF_DIR);
        } else {
            await processPages(pages, OUTPUT_MD_DIR);
        }
        console.log("✅ All pages processed successfully");
    
    } catch (error) {
        console.error("❌ Error during processing:", error);
        // Save the current progress
        throw error;
    }
}
