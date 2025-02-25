import dotenv from "dotenv";
dotenv.config();

// 🔹 Replace with your Confluence details
export const CONFLUENCE_BASE_URL =process.env.CONFLUENCE_BASE_URL;
export const SPACE_KEY = process.env.SPACE_KEY;
export const USER_EMAIL = process.env.USER_EMAIL;
export const API_TOKEN = process.env.API_TOKEN;

// Data cleaning
export const BASE_URL= process.env.BASE_URL;
export const MODEL= process.env.MODEL;
export const API_KEY= process.env.API_KEY;

export const ACTIVE_APP_MODE = process.env.APP_MODE;

export const APP_MODES = {
    LITE: "LITE",
    STANDARD: "STANDARD",
    EXPERT: "EXPERT"
};
