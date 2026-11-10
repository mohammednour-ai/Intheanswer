import fs from "node:fs";
import { createRequire } from "node:module";
import puppeteer, { type Browser } from "puppeteer-core";
import { executablePath } from "../reports/pdf";
import { USER_AGENT } from "../adapters/http";
import type { AxeViolation, RenderMetrics } from "./checks";

/**
 * Headless Chromium checks: mobile layout, rendered text and axe-core
 * (WCAG 2.0 A/AA rules only: an automated subset, not a full audit).
 */

export function proxyArgs(): string[] {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  return p ? [`--proxy-server=${p}`] : [];
}

export async function launchBrowser(): Promise<Browser> {
  const exe = await executablePath();
  return puppeteer.launch({ executablePath: exe.path, args: [...exe.args, ...proxyArgs()], headless: true });
}

let axeSource: string | null = null;
function axe(): string {
  if (!axeSource) {
    const req = createRequire(import.meta.url);
    axeSource = fs.readFileSync(req.resolve("axe-core/axe.min.js"), "utf8");
  }
  return axeSource;
}

// Browser-side code is plain JavaScript in strings: bundlers/tsx add helpers
// (such as __name) to compiled functions that do not exist inside the page.
const MEASURE_JS = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  let textElements = 0, smallTextElements = 0; const smallTextExamples = [];
  document.querySelectorAll("body *").forEach((el) => {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent || "").trim().length > 2);
    if (!own || !visible(el)) return;
    textElements++;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 12) { smallTextElements++; if (smallTextExamples.length < 3) smallTextExamples.push((el.textContent || "").trim().slice(0, 40) + " (" + fs + "px)"); }
  });
  let tapTargets = 0, smallTapTargets = 0; const smallTapExamples = [];
  document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button]").forEach((el) => {
    if (!visible(el)) return;
    const block = el.tagName === "A" ? el.closest("p, li") : null;
    if (block && (block.textContent || "").length > (el.textContent || "").length + 20) return; // inline link in text: exempt (WCAG 2.5.8)
    tapTargets++;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) { smallTapTargets++;
      if (smallTapExamples.length < 3) smallTapExamples.push('"' + ((el.innerText || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 30)) + '" ' + Math.round(r.width) + "x" + Math.round(r.height) + "px"); }
  });
  return { url: location.href, viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth,
    innerWidth, textElements, smallTextElements, smallTextExamples, tapTargets, smallTapTargets, smallTapExamples,
    renderedTextLength: ((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").trim().length };
})()`;

const AXE_RUN_JS = `(async () => {
  const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, resultTypes: ["violations"] });
  return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length }));
})()`;

/**
 * Requests that, if they fail at the network level, make a render unreliable:
 * any stylesheet, or a script/document from the clinic's own site. An HTTP
 * error from the clinic's server is a real result; a network failure is ours.
 */
export function watchCriticalFailures(page: import("puppeteer-core").Page, siteHost: string): string[] {
  const failed: string[] = [];
  page.on("requestfailed", (req) => {
    const type = req.resourceType();
    let host = "";
    try {
      host = new URL(req.url()).hostname.replace(/^www\./, "");
    } catch {
      /* ignore */
    }
    const own = host === siteHost || host.endsWith("." + siteHost);
    if (type === "stylesheet" || ((type === "script" || type === "document") && own)) failed.push(`${type}: ${req.url()}`);
  });
  return failed;
}

export class UnreliableRenderError extends Error {}

export async function measureMobile(browser: Browser, url: string): Promise<RenderMetrics> {
  const page = await browser.newPage();
  const failed = watchCriticalFailures(page, new URL(url).hostname.replace(/^www\./, ""));
  try {
    // A standard phone user agent (so sites serve their mobile layout) that still names our bot.
    await page.setUserAgent(`Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36 ${USER_AGENT}`);
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45_000 });
    const m = (await page.evaluate(MEASURE_JS)) as RenderMetrics;
    if (failed.length) throw new UnreliableRenderError(`page files did not load during the test (${failed.slice(0, 2).join(", ")})`);
    return m;
  } finally {
    await page.close();
  }
}

export async function runAxe(browser: Browser, urls: string[]): Promise<{ violations: AxeViolation[]; tested: string[] }> {
  const byId = new Map<string, AxeViolation>();
  const tested: string[] = [];
  for (const url of urls) {
    const page = await browser.newPage();
    const failed = watchCriticalFailures(page, new URL(url).hostname.replace(/^www\./, ""));
    try {
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(url, { waitUntil: "networkidle2", timeout: 45_000 });
      await page.addScriptTag({ content: axe() });
      const res = (await page.evaluate(AXE_RUN_JS)) as { id: string; impact: string | null; help: string; nodes: number }[];
      if (failed.length) continue; // unstyled or broken render: results would not be about the real page
      tested.push(url);
      for (const v of res) {
        const prev = byId.get(v.id);
        if (prev) {
          prev.nodes += v.nodes;
          prev.pages.push(url);
        } else byId.set(v.id, { ...v, pages: [url] });
      }
    } catch {
      /* page could not be tested; it is simply not in `tested` */
    } finally {
      await page.close();
    }
  }
  return { violations: [...byId.values()], tested };
}
