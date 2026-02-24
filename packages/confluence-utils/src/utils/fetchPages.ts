import axios, { AxiosRequestConfig } from 'axios';
import { sleep } from './sleep';
import { ConfluencePageResponse, ConfluencePage, ConfluenceSearchResponse } from '../types';

export type AuthMode = 'basic' | 'oauth';

export class ConfluencePageFetcher {
    private spaceKey: string;
    private confluenceBaseUrl: string;
    private accessToken: string;
    private userEmail: string;
    private apiToken: string;
    private authMode: AuthMode;

    /**
     * @param spaceKey - The Confluence space key
     * @param confluenceBaseUrl - For basic auth: the full wiki URL (e.g. https://your-domain.atlassian.net/wiki).
     *                            For oauth: the cloudId (the base URL is constructed automatically).
     * @param confluenceToken - Legacy param, same as apiToken for basic auth; ignored for oauth.
     * @param userEmail - User email for basic auth; ignored for oauth.
     * @param apiToken - API token for basic auth; OAuth access token for oauth.
     * @param authMode - 'basic' (default) or 'oauth'
     */
    constructor(
        spaceKey: string,
        confluenceBaseUrl: string,
        confluenceToken: string,
        userEmail: string,
        apiToken: string,
        authMode: AuthMode = 'basic'
    ) {
        this.spaceKey = spaceKey;
        this.accessToken = confluenceToken;
        this.userEmail = userEmail;
        this.apiToken = apiToken;
        this.authMode = authMode;

        if (authMode === 'oauth') {
            // For OAuth, confluenceBaseUrl is the cloudId
            this.confluenceBaseUrl = `https://api.atlassian.com/ex/confluence/${confluenceBaseUrl}`;
        } else {
            this.confluenceBaseUrl = confluenceBaseUrl;
        }
    }

    /**
     * Build the axios request config with the appropriate auth headers
     */
    private getRequestConfig(extraConfig: AxiosRequestConfig = {}): AxiosRequestConfig {
        if (this.authMode === 'oauth') {
            return {
                ...extraConfig,
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${this.accessToken}`,
                    ...(extraConfig.headers || {}),
                },
            };
        }

        // Basic auth (legacy)
        return {
            ...extraConfig,
            headers: {
                Accept: 'application/json',
                ...(extraConfig.headers || {}),
            },
            auth: { username: this.userEmail, password: this.apiToken },
        };
    }

    async fetchPages(cursor: string | null = null, limit: number = 10): Promise<ConfluencePageResponse> {
        try {
            const params: any = {
                limit,
                'body-format': 'storage' // New V2 syntax for body expansion
            };
            if (cursor) {
                params.cursor = cursor;
            }

            // In API V2, we need the Space ID to fetch all pages in a space.
            // First we resolve the spaceKey to a spaceId.
            const spaceResponse = await axios.get(
                `${this.confluenceBaseUrl}/wiki/api/v2/spaces`,
                this.getRequestConfig({ params: { keys: this.spaceKey } })
            );
            
            const spaceId = spaceResponse.data.results?.[0]?.id;
            if (!spaceId) {
                throw new Error(`Could not find space ID for space key: ${this.spaceKey}`);
            }

            // Now fetch the pages for this space ID
            const response = await axios.get<ConfluencePageResponse>(
                `${this.confluenceBaseUrl}/wiki/api/v2/spaces/${spaceId}/pages`,
                this.getRequestConfig({
                    params
                })
            );

            // V2 returns body content in 'body.storage.value'.
            // WebUI links in v2 are relative, but the typing is fine.
            return response.data;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('❌ Error fetching pages:', errorMessage);
            throw error;
        }
    }

    async getTotalPages(): Promise<number> {
        try {
            // Note: /rest/api/search (v1) is still active for search queries according to Atlassian docs, 
            // but let's be safe and use v2 if possible. Actually, there isn't a direct "count" endpoint in V2.
            // We can still use the v1 search API since ONLY /rest/api/content was explicitly deprecated and 410'd.
            const url = `${this.confluenceBaseUrl}/rest/api/search?cql=space=${this.spaceKey}%20and%20type%20=%20page`;
            const response = await axios.get<ConfluenceSearchResponse>(
                url,
                this.getRequestConfig()
            );
            return response.data?.totalSize ?? 0;
        } catch (error) {
            // If v1 search fails with 410, we'll return a fallback estimate.
            if (axios.isAxiosError(error) && error.response?.status === 410) {
                console.warn('V1 Search API is deprecated, returning fallback total.');
                return 1000; // Fallback
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('❌ Error getting total pages:', errorMessage);
            throw error;
        }
    }
}