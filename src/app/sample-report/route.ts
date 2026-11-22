import { sampleTeaser } from "@/lib/reports/sample";
import { renderTeaser } from "@/lib/reports/renderTeaser";
import { LIVE_REVIEWS_MARKER } from "@/lib/reviews/liveTable";
import { fillOffer } from "@/lib/reports/offerSection";
import { sampleOfferContext } from "@/lib/reports/offerContext";

/**
 * The sample report (invented clinic), rendered with the real teaser template.
 * Its plan cards are the published ones (src/lib/offer.ts); with nobody to
 * sell to, their buttons go to the pricing page.
 */
export async function GET() {
  const sample = sampleTeaser();
  const html = fillOffer(renderTeaser(sample).replace(LIVE_REVIEWS_MARKER, ""), await sampleOfferContext(sample.findingsTotal));
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });
}
