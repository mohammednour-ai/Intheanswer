import { sampleTeaser } from "@/lib/reports/sample";
import { renderTeaser } from "@/lib/reports/renderTeaser";
import { LIVE_REVIEWS_MARKER } from "@/lib/reviews/liveTable";

/** The sample report (invented clinic), rendered with the real teaser template. */
export async function GET() {
  const html = renderTeaser(sampleTeaser()).replace(LIVE_REVIEWS_MARKER, "");
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });
}
