/**
 * Draws the tab icons and the share card from the brand mark, colours and fonts.
 *
 *   npm run brand:assets
 *
 * Run it again after a change to the mark, the colours, the heading font or the home page banner
 * photograph, then commit the files:
 *   src/app/icon.svg                tab icon (follows light and dark tabs)
 *   src/app/favicon.ico             tab icon for browsers that do not take an SVG
 *   src/app/apple-icon.png          home-screen icon
 *   src/app/opengraph-image.jpg     the card shown when a link to the site is shared
 *   src/app/opengraph-image.alt.txt
 */
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { launchBrowser } from "../src/lib/sitetest/browser";
import { BRAND } from "../src/lib/brand";
import { HEAD_FONT, embeddedFonts } from "../src/lib/reports/html";

const APP = path.join("src", "app");
const HEADLINE = ["When patients ask AI, are you ", "in the answer?"] as const;
const CARD_ALT = "In The Answer. When patients ask AI, are you in the answer? Free report for dental, family and medspa clinics in Ontario.";

/** The three lines of the mark, on a square canvas. */
const BARS = `<rect class="g" x="8" y="8" width="84" height="20" rx="10"/><rect class="b" x="8" y="42" width="104" height="20" rx="10"/><rect class="g" x="8" y="76" width="64" height="20" rx="10"/>`;

function iconSvg(opts: { followsTheme: boolean }): string {
  const dark = opts.followsTheme ? `@media (prefers-color-scheme: dark){.g{fill:${BRAND.darkGrey}}.b{fill:${BRAND.blueOnDark}}}` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -8 120 120"><style>.g{fill:${BRAND.listGrey}}.b{fill:${BRAND.blue}}${dark}</style>${BARS}</svg>\n`;
}

const page = (body: string, css = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${embeddedFonts()}*{box-sizing:border-box}html,body{margin:0}${css}</style></head><body>${body}</body></html>`;

/** The share card: the home page banner photograph under flat ink, with the mark, the headline and one line. */
function cardHtml(): string {
  const photo = readFileSync(path.join(APP, "(site)", "images", "banner-treatment-room.jpg")).toString("base64");
  const css = `
body{position:relative;width:1200px;height:630px;background:${BRAND.ink} url(data:image/jpeg;base64,${photo}) right center/cover;color:#fff;font-family:Inter,sans-serif;display:flex;flex-direction:column;justify-content:space-between;padding:60px 72px}
body::before{content:"";position:absolute;inset:0;background:${BRAND.ink};opacity:.36}
body>*{position:relative}
.brand{display:flex;align-items:center;gap:16px;font-family:"${HEAD_FONT}",Inter,sans-serif;font-weight:700;font-size:32px;letter-spacing:-.3px}
.brand svg{width:46px;height:46px}
.brand .g{fill:${BRAND.line}}
.brand .b{fill:${BRAND.blueOnDark}}
h1{max-width:600px;margin:0;font-family:"${HEAD_FONT}",Inter,sans-serif;font-weight:700;font-size:74px;line-height:1.04;letter-spacing:-.02em}
h1 span{display:block;color:${BRAND.blueOnDark};white-space:nowrap}
.foot{display:flex;justify-content:space-between;align-items:baseline;border-top:2px solid #fff;padding-top:20px;font-size:24px;color:${BRAND.lineSoft}}
.foot strong{color:#fff;font-weight:600}`;
  const body = `
<div class="brand">${iconSvg({ followsTheme: false })}In The Answer</div>
<h1>${HEADLINE[0]}<span>${HEADLINE[1]}</span></h1>
<div class="foot"><span>Free report for dental, family and medspa clinics in Ontario</span><strong>intheanswer.ca</strong></div>`;
  return page(body, css);
}

/** The mark alone, filling a square of the given size. `ground` is a CSS colour, or null for a see-through icon. */
function markHtml(size: number, pad: number, ground: string | null): string {
  const css = `body{width:${size}px;height:${size}px;background:${ground ?? "transparent"};display:flex;align-items:center;justify-content:center}svg{width:${size - 2 * pad}px;height:${size - 2 * pad}px}`;
  return page(iconSvg({ followsTheme: false }), css);
}

/** An .ico file holding PNG pictures, one for each size. */
function ico(pictures: { size: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pictures.length, 4);
  let offset = 6 + 16 * pictures.length;
  const entries = pictures.map((p) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(p.size, 0);
    e.writeUInt8(p.size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(p.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += p.data.length;
    return e;
  });
  return Buffer.concat([head, ...entries, ...pictures.map((p) => p.data)]);
}

async function main() {
  const browser = await launchBrowser();
  try {
    const tab = await browser.newPage();
    const draw = async (html: string, width: number, height: number, seeThrough: boolean, photo = false): Promise<Buffer> => {
      await tab.setViewport({ width, height, deviceScaleFactor: 1 });
      await tab.setContent(html, { waitUntil: "load" });
      await tab.evaluate("document.fonts.ready.then(() => true)");
      // a card with a photograph on it is saved as a JPEG, a fraction of the size of a PNG
      if (photo) return Buffer.from(await tab.screenshot({ type: "jpeg", quality: 88 }));
      return Buffer.from(await tab.screenshot({ type: "png", omitBackground: seeThrough }));
    };

    await fs.writeFile(path.join(APP, "icon.svg"), iconSvg({ followsTheme: true }));
    const sizes = [16, 32, 48];
    const pictures = [];
    for (const size of sizes) pictures.push({ size, data: await draw(markHtml(size, 0, null), size, size, true) });
    await fs.writeFile(path.join(APP, "favicon.ico"), ico(pictures));
    await fs.writeFile(path.join(APP, "apple-icon.png"), await draw(markHtml(180, 30, "#fff"), 180, 180, false));
    await fs.writeFile(path.join(APP, "opengraph-image.jpg"), await draw(cardHtml(), 1200, 630, false, true));
    // no line break at the end: Next.js copies the file into the page's alt text as it is
    await fs.writeFile(path.join(APP, "opengraph-image.alt.txt"), CARD_ALT);
    console.log("wrote icon.svg, favicon.ico, apple-icon.png, opengraph-image.jpg and its alt text in src/app");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
