import { API_TOKEN, CONFLUENCE_BASE_URL, SPACE_KEY, USER_EMAIL } from "../config.js";
import axios from "axios";
import { sleep } from "./sleep.js";

// 🔹 Fetch all pages from a Confluence space
export async function fetchAllPages() {

    let pages = [];
    let start = 0;
    const limit = 100; // Confluence API returns pages in batches

    try {
        while (true) {
            const { data: { totalSize } } = await getTotalPages();
            console.log(`🟰 Total pages found: ${totalSize} on space ${SPACE_KEY}`);
            const url = `${CONFLUENCE_BASE_URL}/rest/api/content?type=page&spaceKey=${SPACE_KEY}&expand=body.storage,title&limit=${limit}&start=${start}`;
            console.log(`䷢ Fetching pages start from ${start} to ${start + limit}`);
            const response = await axios.get(url, {
                auth: { username: USER_EMAIL, password: API_TOKEN },
                headers: { Accept: "application/json" },
            });

            pages = pages.concat(response.data.results);
            if (response.data.results.length < limit) break; // No more pages to fetch

            start += limit;
            await sleep(1000);
        }

        return pages;
    } catch (error) {
        console.error("❌ Error fetching pages:", error.response ? error.response.data : error);
        process.exit(1);
    }
}
function getTotalPages() {
    const url = `${CONFLUENCE_BASE_URL}/rest/api/search?cql=space=${SPACE_KEY}%20and%20type%20=%20page`;
    return axios.get(url, {
        auth: { username: USER_EMAIL, password: API_TOKEN },
        headers: { Accept: "application/json" },
    })
}

