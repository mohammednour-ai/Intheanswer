import crypto from "node:crypto";
import QRCode from "qrcode";
import { ownerDetails, OWNER_PLACEHOLDER_RE, env } from "../env";
import { embeddedFonts, esc, HEAD_FONT } from "../reports/html";
import { BRAND, VOICE_NAME, markSvg } from "../brand";
import { firstEmailSubject, resultParagraph } from "../emails/firstEmail";
import { scanExclusionsFor, scanLanguage, type Flag } from "../pipeline/verify";
import type { TeaserData } from "../reports/types";

/**
 * The printed letter: the clinic's result as its first email stated it, two findings, and three ways
 * in (the QR code, a short address to type, our phone line with the report code). Nothing in it is
 * new: every fact is taken from the clinic's verified teaser, word for word as the email had it.
 * No prices (they live on the report page and can change after the letter is posted), no review
 * numbers, no urgency.
 *
 * Page: US letter (Canada Post uses 8.5 x 11). PostGrid prints the addresses in a zone 1.375 in from
 * the left and 0.75 in from the top, 2.5 in square, shown through the envelope window: nothing of
 * ours may sit there, and every page keeps a 1/4 inch margin (PostGrid Canada letter guideline).
 */

/** Short code printed on the letter: intheanswer.ca/l/<code>. 10 characters from 31 (about 49 bits), no look-alikes. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const LETTER_CODE_RE = /^[a-hjkmnp-z2-9]{10}$/;

export function newLetterCode(): string {
  let out = "";
  while (out.length < 10) {
    const b = crypto.randomBytes(1)[0];
    if (b < 248) out += ALPHABET[b % 31]; // 248 = 8 x 31: no modulo bias
  }
  return out;
}

export interface LetterInput {
  data: TeaserData;
  code: string;
  /** When the first email went out (Toronto date, e.g. "23 November 2026"); null if there was none. */
  emailedOn: string | null;
  /** Our phone line and the report's six-digit code, when calls are on. */
  phone: { display: string; code: string } | null;
  /** The date printed at the top. */
  date: string;
}

export interface Letter {
  headline: string;
  greeting: string;
  paragraphs: string[];
  findingsIntro: string;
  findings: string[];
  qrUrl: string;
  typedUrl: string;
  stopUrl: string;
  phoneLine: string | null;
  closing: string;
  signature: string[];
  footer: string[];
}

const host = () => new URL(env().APP_URL).host.replace(/^www\./, "");

export function letterUrls(code: string): { qrUrl: string; typedUrl: string; stopUrl: string } {
  const base = env().APP_URL.replace(/\/$/, "");
  return { qrUrl: `${base}/l/${code}?s=qr`, typedUrl: `${host()}/l/${code}`, stopUrl: `${host()}/l/${code}/stop` };
}

export function buildLetter(i: LetterInput): Letter {
  const d = i.data;
  const o = ownerDetails();
  const u = letterUrls(i.code);
  const paragraphs = [resultParagraph(d).text];
  if (i.emailedOn) {
    paragraphs.push(`We emailed you about this on ${i.emailedOn}, with a free report. In case it did not reach the right person, here it is on paper.`);
  }
  const phoneLine = i.phone
    ? `Or phone ${i.phone.display} at any hour and give report code ${i.phone.code.slice(0, 3)} ${i.phone.code.slice(3)}. ${VOICE_NAME}, our AI assistant, answers and can walk you through it.`
    : null;
  return {
    headline: firstEmailSubject(d),
    greeting: `To the owner or manager of ${d.clinic.name},`,
    paragraphs,
    findingsIntro: `Two things we noticed on ${d.clinic.domain}:`,
    findings: d.findings.slice(0, 2).map((f) => f.text),
    ...u,
    phoneLine,
    closing: "The report is free and yours to keep. It also shows what we offer, if you would like the gaps fixed.",
    signature: [o.name, `${o.title}, ${o.businessName}`],
    footer: [
      [o.businessName, o.mailingAddress, o.phone, host()].filter(Boolean).join(" · "),
      `We wrote to you because ${d.clinic.name}'s address is published on ${d.clinic.domain}. To stop all letters, emails and calls from us, go to ${u.stopUrl}${i.phone ? ` or phone ${i.phone.display} and say stop` : ""}.`,
    ],
  };
}

/** Everything a reader sees, as plain text (for the wording checks and the portal). */
export function letterText(l: Letter): string {
  return [l.headline, l.greeting, ...l.paragraphs, l.findingsIntro, ...l.findings, l.typedUrl, l.phoneLine ?? "", l.closing, ...l.signature, ...l.footer]
    .filter(Boolean)
    .join("\n");
}

/**
 * The checks a letter must pass before the owner can approve it. The facts are re-read from the
 * verified teaser (the same gate the email passed); these are the letter's own rules on top.
 */
export function checkLetter(l: Letter, d: TeaserData & { verified?: boolean }, address: string): Flag[] {
  const flags: Flag[] = [];
  const block = (code: string, message: string) => flags.push({ code, message, severity: "block" });
  if (d.verified !== true) block("letter_unverified", "the clinic's report has not passed the fact check");
  if (l.findings.length < 2) block("letter_findings", `the report has ${l.findings.length} finding(s); the letter needs two`);
  for (const f of l.findings) if (!d.findings.some((x) => x.text === f)) block("letter_finding_unsupported", `not in the verified report: "${f.slice(0, 80)}"`);
  if (l.headline !== firstEmailSubject(d)) block("letter_headline", "the headline does not match the stored result");
  const text = letterText(l);
  flags.push(...scanLanguage(text, "letter", scanExclusionsFor(d)));
  // amounts belong on the report page, which always shows the current offer
  if (/\$\s?\d|\b\d+(\.\d+)?\s?(CAD|dollars)\b|\bper month\b|\ba month\b/i.test(text)) block("letter_price", "the letter mentions a price");
  if (/\b\d+(\.\d)?\s*(stars?|reviews?|ratings?)\b/i.test(text)) block("letter_review_number", "review numbers may not be printed");
  if (OWNER_PLACEHOLDER_RE.test(l.signature.join(" ") + l.footer.join(" "))) block("letter_owner_placeholder", "your name, title, business name, address or phone is still a placeholder");
  if (!address.trim() || !/\d/.test(address)) block("letter_no_address", "the clinic's street address is missing");
  return flags;
}

const IN = (n: number) => `${n}in`;
const LETTER_CSS = `
*{box-sizing:border-box}html,body{margin:0;background:#fff;color:${BRAND.ink}}
body{font:10pt/1.38 Inter,system-ui,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{position:relative;width:8.5in;height:11in;overflow:hidden}
/* the brand, the date and the headline sit to the right of the address zone (which ends 3.875 in from the left, 3.25 in from the top) */
.top{position:absolute;left:${IN(4.25)};top:${IN(0.75)};right:${IN(0.6)};height:${IN(2.5)};display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:8px;font-family:"${HEAD_FONT}",Inter,sans-serif;font-weight:700;font-size:13pt}
.date{margin-top:6px;color:${BRAND.muted};font-size:9pt}
.top h1{margin-top:auto}
.body{position:absolute;left:${IN(0.75)};right:${IN(0.75)};top:${IN(3.4)};bottom:${IN(0.45)};display:flex;flex-direction:column}
h1{font-family:"${HEAD_FONT}",Inter,sans-serif;font-size:13.5pt;line-height:1.25;margin:0}
p{margin:0 0 0.09in}
ol{margin:0 0 0.1in;padding-left:0.24in}li{margin-bottom:0.04in}
.cta{display:flex;gap:0.2in;align-items:center;border:1.5pt solid ${BRAND.ink};border-radius:10px;padding:0.1in 0.16in;margin:0.02in 0 0.1in}
.cta svg{width:1.15in;height:1.15in;display:block;flex:none}
.cta strong{display:block;font-family:"${HEAD_FONT}",Inter,sans-serif;font-size:11pt;line-height:1.3}
.url{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;font-size:11.5pt;margin:2px 0}
.sig{margin-top:0.06in}.sig b{display:block}
.foot{margin-top:auto;font-size:8pt;color:${BRAND.muted};border-top:1px solid ${BRAND.line};padding-top:0.07in}
.foot p{margin:0 0 2px}
`;

export async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: BRAND.ink, light: "#FFFFFF" } });
}

export async function renderLetterHtml(l: Letter, date: string): Promise<string> {
  const qr = await qrSvg(l.qrUrl);
  const body = `<div class="sheet">
  <div class="top"><div class="brand">${markSvg({ width: 24 })}In The Answer</div><div class="date">${esc(date)}</div><h1>${esc(l.headline)}</h1></div>
  <div class="body">
    <p>${esc(l.greeting)}</p>
    ${l.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n    ")}
    <p>${esc(l.findingsIntro)}</p>
    <ol>${l.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ol>
    <div class="cta">
      <div role="img" aria-label="QR code to your free report">${qr}</div>
      <div><strong>Scan to open your free report: every question, who was named, and a third finding.</strong>
        <div>Or type</div><div class="url">${esc(l.typedUrl)}</div>
        ${l.phoneLine ? `<div>${esc(l.phoneLine)}</div>` : ""}</div>
    </div>
    <p>${esc(l.closing)}</p>
    <div class="sig"><b>${esc(l.signature[0])}</b>${l.signature.slice(1).map((s) => esc(s)).join("<br>")}</div>
    <div class="foot">${l.footer.map((f) => `<p>${esc(f)}</p>`).join("")}</div>
  </div>
</div>`;
  return `<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><title>Letter</title><style>${embeddedFonts()}${LETTER_CSS}@page{size:8.5in 11in;margin:0}</style></head><body>${body}</body></html>`;
}
