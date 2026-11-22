/**
 * Pictures of our own pages, for looking at a design change before and after.
 * Start the site first (npm run dev), then:
 *
 *   npm run shots -- before                    writes output/shots/before/<page>-<width>.png
 *   npm run shots -- after /buy/abc/one-time   the same, plus any extra paths given
 *   npm run shots -- forms --only /intake/abc  only the paths given (pages that need a token)
 *   npm run shots -- --compare before after    prints how much of each picture changed and
 *                                              writes output/shots/before-vs-after/ (changes in red)
 *
 * BASE sets the address (default http://localhost:3000). output/ is not committed.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { launchBrowser } from "../src/lib/sitetest/browser";

const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = path.join("output", "shots");
/** Every public page that renders without a token. */
const PAGES = ["/", "/how-it-works", "/pricing", "/sample", "/sample-report", "/contact", "/privacy", "/bot", "/unsubscribe"];
/** Phone, tablet, desktop. */
const WIDTHS = [390, 768, 1280];

type Png = `${string}.png`;

function fileName(page: string, width: number): Png {
  const name = page === "/" ? "home" : page.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-");
  return `${name}-${width}.png`;
}

async function take(label: string, paths: string[]) {
  const dir = path.join(OUT, label);
  await fs.mkdir(dir, { recursive: true });
  const browser = await launchBrowser();
  let bad = 0;
  let sideways = 0;
  try {
    for (const p of paths) {
      for (const width of WIDTHS) {
        const page = await browser.newPage();
        try {
          await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
          const res = await page.goto(BASE + p, { waitUntil: "networkidle0", timeout: 90_000 });
          // The development badge is not part of the page.
          await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
          await page.evaluate(SETTLE_JS);
          const file = path.join(dir, fileName(p, width)) as Png;
          await page.screenshot({ path: file, fullPage: true });
          const status = res?.status() ?? 0;
          if (status !== 200) bad++;
          // A page wider than its window scrolls sideways: always a fault.
          const over = (await page.evaluate("document.documentElement.scrollWidth - window.innerWidth")) as number;
          if (over > 0) sideways++;
          console.log(`${status}  ${file}${over > 0 ? `   SCROLLS SIDEWAYS by ${over}px` : ""}`);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  if (bad) console.error(`${bad} picture(s) are of a page that did not answer 200`);
  if (sideways) console.error(`${sideways} picture(s) are of a page that scrolls sideways`);
  if (bad || sideways) process.exit(1);
}

// Browser-side code is plain JavaScript in a string, as in src/lib/sitetest/browser.ts:
// tsx adds helpers to compiled functions that do not exist inside the page.

/** Scrolls through the page so photos lower down load, then waits for images and fonts. */
const SETTLE_JS = `(async () => {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let y = 0; y < document.documentElement.scrollHeight; y += window.innerHeight) { window.scrollTo(0, y); await pause(80); }
  window.scrollTo(0, 0);
  const loaded = Promise.all([...document.images].map((i) => i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })));
  await Promise.race([loaded, pause(8000)]);
  await document.fonts.ready;
  await pause(100);
  return true;
})()`;

const DIFF_JS = `(() => {
  const a = document.getElementById("a"), b = document.getElementById("b");
  const w = Math.max(a.naturalWidth, b.naturalWidth), h = Math.max(a.naturalHeight, b.naturalHeight);
  const read = (img) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0);
    return x.getImageData(0, 0, w, h).data;
  };
  const da = read(a), db = read(b);
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const ox = out.getContext("2d"); const od = ox.createImageData(w, h);
  let changed = 0, firstRow = -1, lastRow = -1;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
    if (d > 24) {
      changed++;
      const row = Math.floor(i / 4 / w); if (firstRow < 0) firstRow = row; lastRow = row;
      od.data[i] = 220; od.data[i + 1] = 30; od.data[i + 2] = 30;
    } else {
      const grey = 255 - (255 - (db[i] + db[i + 1] + db[i + 2]) / 3) * 0.3;
      od.data[i] = od.data[i + 1] = od.data[i + 2] = grey;
    }
    od.data[i + 3] = 255;
  }
  ox.putImageData(od, 0, 0);
  return { changed, total: w * h, heightA: a.naturalHeight, heightB: b.naturalHeight, firstRow, lastRow, png: out.toDataURL("image/png") };
})()`;

type Diff = { changed: number; total: number; heightA: number; heightB: number; firstRow: number; lastRow: number; png: string };

async function compare(a: string, b: string) {
  const dirA = path.join(OUT, a);
  const dirB = path.join(OUT, b);
  const dirD = path.join(OUT, `${a}-vs-${b}`);
  await fs.mkdir(dirD, { recursive: true });
  const names = (await fs.readdir(dirA)).filter((n) => n.endsWith(".png")).sort();
  const dataUrl = (buf: Buffer) => `data:image/png;base64,${buf.toString("base64")}`;
  const browser = await launchBrowser();
  let moved = 0;
  try {
    const page = await browser.newPage();
    for (const name of names) {
      const bufA = await fs.readFile(path.join(dirA, name));
      const bufB = await fs.readFile(path.join(dirB, name)).catch(() => null);
      if (!bufB) {
        console.log(`   (none)  ${name}: not in ${b}`);
        continue;
      }
      await page.setContent(`<img id="a" src="${dataUrl(bufA)}"><img id="b" src="${dataUrl(bufB)}">`, { waitUntil: "load" });
      const r = (await page.evaluate(DIFF_JS)) as Diff;
      const share = (100 * r.changed) / r.total;
      const height = r.heightA === r.heightB ? "same height" : `height ${r.heightA} → ${r.heightB}px`;
      const where = r.changed ? `, rows ${r.firstRow}–${r.lastRow}` : "";
      console.log(`${share.toFixed(2).padStart(6)}%  ${name}: ${height}${where}`);
      if (r.changed) {
        moved++;
        await fs.writeFile(path.join(dirD, name), Buffer.from(r.png.slice(r.png.indexOf(",") + 1), "base64"));
      }
    }
  } finally {
    await browser.close();
  }
  console.log(moved ? `${moved} picture(s) changed; see ${dirD}` : "no picture changed");
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--compare") {
    if (args.length !== 3) throw new Error("usage: npm run shots -- --compare <before> <after>");
    await compare(args[1], args[2]);
    return;
  }
  const [label, ...rest] = args;
  if (!label || label.startsWith("-")) throw new Error("usage: npm run shots -- <label> [--only] [extra paths]");
  const only = rest.includes("--only");
  const extra = rest.filter((a) => a !== "--only");
  if (only && !extra.length) throw new Error("--only needs at least one path");
  await take(label, only ? extra : [...PAGES, ...extra]);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
