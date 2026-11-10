/** Renders the invented-clinic sample report to output/sample.html and output/sample.pdf. */
import fs from "node:fs/promises";
import { sampleTeaser } from "../src/lib/reports/sample";
import { renderTeaser } from "../src/lib/reports/renderTeaser";
import { htmlToPdf } from "../src/lib/reports/pdf";

async function main() {
  const html = renderTeaser(sampleTeaser());
  await fs.mkdir("output", { recursive: true });
  await fs.writeFile("output/sample.html", html);
  await fs.writeFile("output/sample.pdf", await htmlToPdf(html));
  console.log("wrote output/sample.html and output/sample.pdf");
}
main();
