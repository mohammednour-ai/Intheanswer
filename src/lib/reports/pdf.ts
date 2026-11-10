import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { env } from "../env";

/**
 * HTML → PDF with headless Chromium. Locally uses CHROME_PATH (or the
 * pre-installed Chromium); on Vercel uses @sparticuz/chromium.
 */
export async function executablePath(): Promise<{ path: string; args: string[] }> {
  const local: string[] = [];
  try {
    for (const d of fs.readdirSync("/opt/pw-browsers")) if (/^chromium-\d+$/.test(d)) local.push(`/opt/pw-browsers/${d}/chrome-linux64/chrome`);
  } catch {
    /* not present */
  }
  const candidates = [env().CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_BIN, ...local];
  for (const c of candidates) {
    if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return { path: c, args: ["--no-sandbox", "--headless=new"] };
  }
  const chromium = (await import("@sparticuz/chromium")).default;
  return { path: await chromium.executablePath(), args: chromium.args };
}

export async function htmlToPdf(html: string): Promise<Buffer> {
  const exe = await executablePath();
  const browser = await puppeteer.launch({ executablePath: exe.path, args: exe.args, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "Letter", printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
