import puppeteer from "puppeteer-core";
import { executablePath } from "../reports/pdf";

/**
 * Whether a letter fits its one page: the text block must not run past the bottom margin (the page
 * clips it, so an overlong letter would lose its footer and opt-out line). Measured in the same
 * browser that makes the PDF.
 */
export async function letterFits(html: string): Promise<boolean> {
  const exe = await executablePath();
  const browser = await puppeteer.launch({ executablePath: exe.path, args: exe.args, headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 816, height: 1056 });
    await page.setContent(html, { waitUntil: "load" });
    // the text block, and the heading block beside the address window
    return await page.evaluate(() =>
      [".body", ".top"].every((sel) => {
        const b = document.querySelector(sel) as HTMLElement | null;
        return !!b && b.scrollHeight <= b.clientHeight + 1;
      }),
    );
  } finally {
    await browser.close();
  }
}
