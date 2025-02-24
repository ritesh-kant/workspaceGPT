import OpenAI from "openai";
import { API_KEY, BASE_URL, MODEL } from "../config.js";

const openai = new OpenAI({
    baseURL: BASE_URL,
    apiKey: API_KEY
});

export async function enhanceTextBatch(batch) {
    const prompt = batch.map(({ filename, text, pageUrl }) => 
        `File: ${filename}\nText: ${text}\nPage: ${pageUrl}`
    ).join("\n\n---\n\n");

    const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [
            { 
                role: "system", 
                content: "You are an AI that improves text readability for embeddings" 
            },
            {
                role: "user",
                content: `Respond only in markdown format without any additional instructions also do not include the file name in the response, just provide the markdown text and remove emojis if present. If you can't find any relevant text then just give empty markdown:\n\n${prompt}`
            },
        ],
    });

    return response.choices[0].message.content;
}