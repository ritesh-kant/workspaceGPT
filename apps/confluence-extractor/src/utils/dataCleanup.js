import fs from "fs";
import { processPages } from "./batchProcessor.js";

export async function processAllPDFs(pages, OUTPUT_DIR) {
  

    try {
        await processPages(pages, OUTPUT_DIR);
        console.log("✅ All pages processed successfully");
    
    } catch (error) {
        console.error("❌ Error during processing:", error);
        // Save the current progress
        throw error;
    }
}
