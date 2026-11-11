import type { MetadataRoute } from "next";

const BASE = process.env.APP_URL ?? "https://intheanswer.ca";

/** Everyone, including AI crawlers, may read the public site. Private areas are excluded. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/portal", "/r/", "/approve/", "/connect/", "/api/", "/auth/", "/unsubscribe/"] },
    sitemap: `${BASE}/sitemap.xml`,
  };
}
