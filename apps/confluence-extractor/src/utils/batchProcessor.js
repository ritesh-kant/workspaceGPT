import fs from "fs";
import path from "path";
import { enhanceTextBatch } from "./textEnhancer.js";
import { extractTextFromXML } from "./xmlParser.js";
import { CONFLUENCE_BASE_URL } from "../config.js";

const BATCH_SIZE = 7;

export async function processBatch(batch, OUTPUT_DIR) {
    const bodyContent = batch.map((item) => ({
        filename: item.title,
        pageUrl: CONFLUENCE_BASE_URL + item._links.webui,
        text: item.body.storage.value
    }));

    const parsedData = bodyContent.map(item => ({
        pageUrl: item.pageUrl,
        filename: item.filename,
        text: extractTextFromXML(item.text)
    }));

    const enhancedBatchText = await enhanceTextBatch(parsedData);
    const cleanBatchText = enhancedBatchText.replaceAll("```", "").replaceAll("markdown", "");
    const enhancedTexts = cleanBatchText.split("\n\n---\n\n");

    batch.forEach((file, index) => {
        const outputFilePath = path.join(OUTPUT_DIR, `${file.title}.md`);
        if (enhancedTexts?.[index]?.length > 60) {
            fs.writeFileSync(outputFilePath, enhancedTexts[index], "utf8");
        } else {
            console.log(`⚠️ No text found for ${file.title}`);
        }
    });
}

export { BATCH_SIZE };