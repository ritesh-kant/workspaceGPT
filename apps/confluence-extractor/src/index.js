import path from "path";
import { ConfluenceExtractor } from "./utils/ConfluenceExtractor.js";

async function main() {
    try {
        const rootDir = path.resolve("../../");
        const extractor = new ConfluenceExtractor(rootDir);
        await extractor.initialize();
        await extractor.process();
    } catch (error) {
        console.error("❌ Application failed:", error.message);
        process.exit(1);
    }
}

// Run the application
main();
