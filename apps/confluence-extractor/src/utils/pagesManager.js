import fs from "fs";
import { fetchAllPages } from "./fetchPages.js";

export class PagesManager {
    constructor(confluenceFilePath) {
        this.confluenceFilePath = confluenceFilePath;
    }

    async getPages() {
        let pages = this.loadPagesFromFile();

        if (!pages?.length) {
            pages = await this.fetchAndSavePages();
        }

        return pages;
    }

    loadPagesFromFile() {
        try {
            if (fs.existsSync(this.confluenceFilePath)) {
                console.log('📖 Reading from confluence_pages.json');
                const rawData = fs.readFileSync(this.confluenceFilePath, 'utf8');
                return JSON.parse(rawData);
            }
        } catch (error) {
            console.error('⚠️ Error reading pages file:', error.message);
        }
        return [];
    }

    async fetchAndSavePages() {
        try {
            const pages = await fetchAllPages();
            console.log("📝 Writing to confluence_pages.json...");
            fs.writeFileSync(
                this.confluenceFilePath, 
                JSON.stringify(pages, null, 2), 
                'utf8'
            );
            return pages;
        } catch (error) {
            console.error('⚠️ Error fetching pages:', error.message);
            throw error;
        }
    }
}