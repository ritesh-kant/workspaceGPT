import fs from "fs";
import path from "path";

export class FolderManager {
    constructor(rootDir) {
        this.rootDir = rootDir;
        this.paths = {
            confluence: path.resolve(rootDir, "./.data/confluence/pages"),
            output: path.resolve(rootDir, "./.data/confluence/pdfs"),
            cleanOutput: path.resolve(rootDir, "./.data/confluence/mds")
        };
    }

    initialize() {
        Object.values(this.paths).forEach(folderPath => {
            if (!fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath, { recursive: true });
                console.log(`📁 Created folder: ${folderPath}`);
            }
        });
    }

    getConfluenceFilePath() {
        return path.resolve(this.paths.confluence, "confluence_pages.json");
    }

    getPaths() {
        return this.paths;
    }
}