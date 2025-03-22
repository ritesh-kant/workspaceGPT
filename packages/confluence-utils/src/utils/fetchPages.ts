import axios from 'axios';
import { sleep } from './sleep';
import { ConfluencePageResponse, ConfluencePage, ConfluenceSearchResponse } from '../types';

export class ConfluencePageFetcher {
    private spaceKey: string;
    private confluenceBaseUrl: string;
    private confluenceToken: string;
    private userEmail: string;
    private apiToken: string;

    constructor(spaceKey: string, confluenceBaseUrl: string, confluenceToken: string, userEmail: string, apiToken: string) {
        this.spaceKey = spaceKey;
        this.confluenceBaseUrl = confluenceBaseUrl;
        this.confluenceToken = confluenceToken;
        this.userEmail = userEmail;
        this.apiToken = apiToken;
    }

    async fetchPages(): Promise<ConfluencePage[]> {
        const headers = {
            'Accept': 'application/json'
        };
        const auth = { username: this.userEmail, password: this.apiToken };

        let allPages: ConfluencePage[] = [];
        let start = 0;
        const limit = 10;
        let hasMore = true;

        while (hasMore) {
            try {
                const response = await axios.get<ConfluencePageResponse>(
                    `${this.confluenceBaseUrl}/rest/api/content`,
                    {
                        headers,
                        auth,
                        params: {
                            spaceKey: this.spaceKey,
                            expand: 'body.storage,_links.webui',
                            start,
                            limit,
                            status: 'current'
                        }
                    }
                );

                const { results, size, _links } = response.data;
                allPages = allPages.concat(results);

                if (!_links.next) {
                    hasMore = false;
                } else {
                    start += size;
                    await sleep(1000); // Rate limiting
                }

                console.log(`✅ Fetched ${allPages.length} pages`);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error('❌ Error fetching pages:', errorMessage);
                throw error;
            }
        }

        return allPages;
    }

    async getTotalPages(): Promise<number> {
        try {
            const url = `${this.confluenceBaseUrl}/rest/api/search?cql=space=${this.spaceKey}%20and%20type%20=%20page`;
            const response = await axios.get<ConfluenceSearchResponse>(url, {
                auth: { username: this.userEmail, password: this.apiToken },
                headers: { Accept: 'application/json' },
            });
            return response.data?.totalSize ?? 0;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('❌ Error getting total pages:', errorMessage);
            throw error;
        }
    }
}