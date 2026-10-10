import type { MetadataRoute } from "next";
import { CHANGELOG } from "./changelog/entries";
import { USE_CASES } from "./use-cases/content";

const SITE_URL = "https://www.workspacegpt.in";

// lastModified is a real date, not `new Date()`: a sitemap that claims every
// page changed on every crawl teaches search engines to ignore the field.
const LATEST_RELEASE = CHANGELOG[0].date;

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: LATEST_RELEASE,
      changeFrequency: "weekly",
      priority: 1,
    },
    ...USE_CASES.map((u) => ({
      url: `${SITE_URL}/use-cases/${u.slug}`,
      lastModified: u.updated,
      changeFrequency: "monthly" as const,
      priority: 0.9,
    })),
    {
      url: `${SITE_URL}/docs`,
      lastModified: LATEST_RELEASE,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/docs/deployment`,
      lastModified: LATEST_RELEASE,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/changelog`,
      lastModified: LATEST_RELEASE,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/support`,
      lastModified: "2026-09-28",
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified: "2026-09-28",
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
