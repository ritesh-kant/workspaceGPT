import path from "path";
import fs from "fs";
import { ConfluencePageFetcher, createFolders, processPage } from "@workspace-gpt/confluence-utils";
import { API_TOKEN, CONFLUENCE_BASE_URL, SPACE_KEY, USER_EMAIL } from "./config.js";

interface ProcessedPage {
    filename: string;
    text: string;
    pageUrl?: string;
}

async function main(): Promise<void> {
    try {
        const rootDir = path.resolve("../../");

        const confluencePagesPath = path.resolve(rootDir, "./.data/confluence/pages");
        const confluencePdfsPath = path.resolve(rootDir, "./.data/confluence/pdfs");
        const confluenceMdsPath = path.resolve(rootDir, "./.data/confluence/mds");

        // Create folders
        const DIRS = [confluencePdfsPath, confluenceMdsPath];
        createFolders(DIRS);

        // read pages from file
        const pagesContent = fs.readFileSync(path.join(confluencePagesPath, "confluence_pages.json"), "utf8");
        const pages = JSON.parse(pagesContent);
        
        // Process pages
        console.log(`🚀 Starting sequential processing...`);
        for (const [index, page] of pages.entries()) {
            try {
                const processedPage = processPage(page) as ProcessedPage;
                const outputFilePath = path.join(confluenceMdsPath, `${processedPage.filename}.md`);

                if (processedPage.text.length > 60) {
                    fs.writeFileSync(outputFilePath, processedPage.text, "utf8");
                    console.log(`✅ Processed page: ${index + 1}/${pages.length} and saved: ${processedPage.filename}`);
                } else {
                    console.log(`⚠️ No text found for ${index}`);
                }
            } catch (error) {
                console.error(`❌ Error processing page ${page.title}:`, error instanceof Error ? error.message : String(error));
                process.exit(1);
            }
        }

        console.log("✅ All pages processed successfully");

    } catch (error) {
        console.error("❌ Application failed:", error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

// Run the application
main().catch(error => {
    console.error("❌ Unhandled error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
});