import dotenv from "dotenv";
dotenv.config();

// 🔹 Replace with your Confluence details
export const CONFLUENCE_BASE_URL =process.env.CONFLUENCE_BASE_URL;
export const SPACE_KEY = process.env.SPACE_KEY;
export const USER_EMAIL = process.env.USER_EMAIL;
export const API_TOKEN = process.env.API_TOKEN;
