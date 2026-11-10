import type { Evidence } from "../pipeline/audit/types";

export type SiteResult = "pass" | "needs_work" | "could_not_test";

export interface SiteCheck {
  key: string;
  category: "speed" | "mobile" | "links" | "content" | "accessibility" | "booking" | "crawlability" | "security";
  result: SiteResult;
  /** Patient impact: higher sorts first. */
  impact: number;
  /** One plain-language line of what was observed. */
  line: string;
  /** Report sentence when the result is needs_work (never for could_not_test). */
  findingText?: string;
  evidence: Evidence[];
  metrics?: Record<string, unknown>;
}

export const SITE_CHECK_LABELS: Record<string, string> = {
  booking_path: "Booking or phone within two taps",
  mobile_layout: "Mobile layout",
  speed_mobile: "Speed on mobile",
  speed_desktop: "Speed on desktop",
  broken_links: "Broken links",
  broken_images: "Broken images",
  titles_descriptions: "Page titles and descriptions",
  alt_text: "Image descriptions (alt text)",
  heading_order: "Heading order",
  accessibility: "Accessibility (automated checks)",
  crawl_robots_sitemap: "robots.txt and sitemap",
  crawl_ai_bots: "AI crawlers",
  crawl_real_text: "Key content as real text",
  https: "HTTPS",
  mixed_content: "Mixed content",
};

/** Default patient-impact order (higher = more direct effect on a patient). */
export const IMPACT: Record<string, number> = {
  booking_path: 100,
  mobile_layout: 92,
  speed_mobile: 88,
  https: 86,
  broken_links: 82,
  crawl_real_text: 80,
  accessibility: 76,
  crawl_ai_bots: 72,
  mixed_content: 64,
  speed_desktop: 58,
  broken_images: 54,
  alt_text: 48,
  titles_descriptions: 44,
  heading_order: 40,
  crawl_robots_sitemap: 36,
};

export const A11Y_LABEL = "automated checks, not a full accessibility audit";
