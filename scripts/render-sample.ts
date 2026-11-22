/** Renders the invented-clinic sample report to output/sample.html and output/sample.pdf. */
import fs from "node:fs/promises";
import { sampleTeaser } from "../src/lib/reports/sample";
import { renderTeaser } from "../src/lib/reports/renderTeaser";
import { htmlToPdf } from "../src/lib/reports/pdf";
import { fillOffer } from "../src/lib/reports/offerSection";
import { sampleOfferContext } from "../src/lib/reports/offerContext";
import { LIVE_REVIEWS_MARKER } from "../src/lib/reviews/liveTable";
import { closeDb } from "../src/lib/db";

async function main() {
  // as /sample-report serves it: the plan cards written in from src/lib/offer.ts
  const sample = sampleTeaser();
  const html = fillOffer(renderTeaser(sample).replace(LIVE_REVIEWS_MARKER, ""), await sampleOfferContext(sample.findingsTotal));
  await closeDb();
  await fs.mkdir("output", { recursive: true });
  await fs.writeFile("output/sample.html", html);
  await fs.writeFile("output/sample.pdf", await htmlToPdf(html));
  console.log("wrote output/sample.html and output/sample.pdf");
}
main();
