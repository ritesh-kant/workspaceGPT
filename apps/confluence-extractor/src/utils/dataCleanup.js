import fs from "fs";
import { processBatch, BATCH_SIZE } from "./batchProcessor.js";

export async function processAllPDFs(pages, OUTPUT_DIR) {
    let startIndex = 0;

    try {
        // Read the last processed batch index from the file
        const lastBatchIndex = fs.readFileSync("./.batchTrack", "utf8");
        startIndex = parseInt(lastBatchIndex) ?? 0;
    } catch (error) {
        // Ignore error if file doesn't exist
    }

    for (let i = startIndex; i < pages.length; i += BATCH_SIZE) {
        const batch = pages.slice(i, i + BATCH_SIZE);
        console.log(`🚀 Sending batch ${i / BATCH_SIZE + 1} to OpenAI...`);

        try {
            await processBatch(batch, OUTPUT_DIR);
            console.log(`✅ Batch ${i / BATCH_SIZE + 1} processed and saved.`);
            // Update the last processed batch index
            fs.writeFileSync("./.batchTrack", `${i + BATCH_SIZE}`, "utf8");
        } catch (error) {
            console.error(`❌ Error enhancing batch ${i / BATCH_SIZE + 1}:`, error);
        }
    }
    console.log("🎉 All PDFs processed and saved!");
}
