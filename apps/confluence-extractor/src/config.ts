import dotenv from "dotenv";
dotenv.config();

export enum AppMode {
  LITE = "LITE",
  STANDARD = "STANDARD",
  EXPERT = "EXPERT"
}

// Confluence configuration
export const CONFLUENCE_BASE_URL: string = process.env.CONFLUENCE_BASE_URL ?? "";
export const SPACE_KEY: string = process.env.SPACE_KEY ?? "";
export const USER_EMAIL: string = process.env.USER_EMAIL ?? "";
export const API_TOKEN: string = process.env.API_TOKEN ?? "";

// Data cleaning configuration
export const BASE_URL: string = process.env.BASE_URL ?? "";
export const MODEL: string = process.env.MODEL ?? "";
export const API_KEY: string = process.env.API_KEY ?? "";

export const ACTIVE_APP_MODE: AppMode = (process.env.APP_MODE as AppMode) ?? AppMode.STANDARD;

export const APP_MODES = {
  LITE: AppMode.LITE,
  STANDARD: AppMode.STANDARD,
  EXPERT: AppMode.EXPERT
} as const;