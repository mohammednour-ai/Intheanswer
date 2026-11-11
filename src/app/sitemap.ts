import type { MetadataRoute } from "next";

const BASE = process.env.APP_URL ?? "https://intheanswer.ca";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/how-it-works", "/pricing", "/sample", "/contact", "/privacy", "/bot", "/unsubscribe"].map((p) => ({ url: `${BASE}${p}`, changeFrequency: "monthly" }));
}
