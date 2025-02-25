import fs from "fs";
import path from "path";
import { enhanceTextBatch } from "./textEnhancer.js";
import { extractTextFromXML } from "./xmlParser.js";
import { CONFLUENCE_BASE_URL } from "../config.js";

export async function processPages(pages, OUTPUT_DIR) {
    let startIndex = 0;

    try {
        // Read the last processed index from the file
        const lastIndex = fs.readFileSync("./.batchTrack", "utf8");
        startIndex = parseInt(lastIndex) ?? 0;
    } catch (error) {
        // Ignore error if file doesn't exist
    }
    const remainingPages = pages.slice(startIndex);
    console.log(`🚀 Starting sequential processing from index ${startIndex}...`);


    for (const [index, page] of remainingPages.entries()) {
        try {
            // Process single page
            const pageContent = {
                filename: page.title,
                pageUrl: CONFLUENCE_BASE_URL + page._links.webui,
                text: page.body.storage.value
            };

            // Parse the content
            const parsedContent = {
                pageUrl: pageContent.pageUrl,
                filename: pageContent.filename,
                text: extractTextFromXML(pageContent.text)
            };

            // Enhance the text
            const enhancedText = await enhanceTextBatch(parsedContent);
            const cleanText = enhancedText.replaceAll("```", "").replaceAll("markdown", "");

            // Save to file
            const safeTitle = pageContent.filename.replace(/[\/\\:*?"<>|]/g, '_');
            const outputFilePath = path.join(OUTPUT_DIR, `${safeTitle}.md`);

            if (cleanText.length > 60) {
                fs.writeFileSync(outputFilePath, cleanText, "utf8");
                console.log(`✅ Processed page: ${startIndex+index}/${pages.length} and saved: ${safeTitle}`);
            } else {
                console.log(`⚠️ No text found for ${startIndex+index} content: ${cleanText}`);
            }

            // Clear the tracking file since we're done
            fs.writeFileSync("./.batchTrack", startIndex+index + "", "utf8");
        } catch (error) {
            console.error(`❌ Error processing page ${page.title}:`, error);
            process.exit(1);
        }
    }
}

