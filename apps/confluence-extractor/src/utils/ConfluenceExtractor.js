import { FolderManager } from "./folderManager.js";
import { PagesManager } from "./pagesManager.js";
import { processAllPDFs } from "./dataCleanup.js";

export class ConfluenceExtractor {
    constructor(rootDir) {
        this.folderManager = new FolderManager(rootDir);
        this.pagesManager = null;
    }

    async initialize() {
        // Setup folders
        this.folderManager.initialize();
        
        // Initialize pages manager
        this.pagesManager = new PagesManager(
            this.folderManager.getConfluenceFilePath()
        );
    }

    async process() {
        try {
            // Get pages
            const pages = await this.pagesManager.getPages();
            console.log("📄 Fetched Pages:", pages.length);

            // Process PDFs
            const paths = this.folderManager.getPaths();
            await processAllPDFs(pages, paths.cleanOutput);

            console.log("✅ Processing completed successfully");
        } catch (error) {
            console.error("❌ Processing failed:", error.message);
            throw error;
        }
    }
}