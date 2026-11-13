import QRCode from "qrcode";
import { db } from "../db";
import { ownerDetails, OWNER_PLACEHOLDER_RE, env } from "../env";
import { embeddedFonts, esc } from "../reports/html";
import { markSvg } from "../brand";
import { verifyTeaser, scanLanguage, claudeVerifier, type Flag, type ModelVerifier } from "../pipeline/verify";
import { ensureCode, shortUrl, typedUrl } from "../qr";
import { getChannel } from "../channels/settings";
import type { TeaserData } from "../reports/types";

/**
 * The printed letter and the follow-up postcard. Content comes only from the
 * clinic's stored, verified teaser. No prices, no guarantees, no urgency.
 * The existing verification gate re-checks every claim before a piece can be
 * queued, and letter-only rules are checked on top.
 */
export interface LetterData {
  kind: "letter" | "postcard";
  clinicId: string;
  clinicName: string;
  city: string;
  headlineVariant: "A" | "B";
  headline: string;
  testDate: string;
  assistant: string;
  findings: { title: string; text: string; date: string }[];
  namedInstead: string[];
  code: string;
  qrUrl: string;
  typedUrl: string;
  inboundNumber: string;
  owner: { name: string; businessName: string; mailingAddress: string; phone: string; website: string };
  optOutLine: string;
  scoreId: string;
  reportId: string;
}

const plural = (n: number, a: string, b: string) => `${n} ${n === 1 ? a : b}`;

/** Two headline wordings for the in-channel A/B test. Both state the same stored fact. */
export function headlineFor(variant: "A" | "B", d: { assistant: string; total: number; recommended: number; city: string; clinic: string }): string {
  return variant === "A"
    ? `We asked an AI assistant ${plural(d.total, "question", "questions")} a patient in ${d.city} would ask. It recommended ${d.clinic} in ${d.recommended} of ${d.total}.`
    : `${d.clinic} was recommended in ${d.recommended} of ${d.total} answers when we asked an AI assistant what a patient in ${d.city} would ask.`;
}

export async function buildLetterData(clinicId: string, kind: "letter" | "postcard", variant: "A" | "B"): Promise<LetterData> {
  const sql = db();
  const [r] = await sql<{ id: string; score_id: string; data: TeaserData & { verified?: boolean } }[]>`
    select id, score_id, data from reports where clinic_id=${clinicId} and kind='teaser' and not superseded and (data->>'verified')::boolean
    order by created_at desc limit 1`;
  if (!r) throw new Error("no verified teaser for this clinic");
  const d = r.data;
  const code = await ensureCode(clinicId);
  const o = ownerDetails();
  const inbound = (await getChannel("inbound")).number as string;
  const count = new Map<string, number>();
  d.rows.forEach((row) => row.namedInstead.forEach((n) => count.set(n, (count.get(n) ?? 0) + 1)));
  const website = new URL(env().APP_URL).host;
  return {
    kind,
    clinicId,
    clinicName: d.clinic.name,
    city: d.clinic.city,
    headlineVariant: variant,
    headline: headlineFor(variant, { assistant: d.test.assistant, total: d.score.total, recommended: d.score.recommended, city: d.clinic.city, clinic: d.clinic.name }),
    testDate: d.test.date,
    assistant: `${d.test.assistant} (${d.test.servedModels.join(", ")}), web search on`,
    findings: d.findings.slice(0, 3).map((f) => ({ title: f.title, text: f.text, date: d.test.date })),
    namedInstead: [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n),
    code,
    qrUrl: shortUrl(code, "q"),
    typedUrl: typedUrl(code),
    inboundNumber: inbound,
    owner: { name: o.name, businessName: o.businessName, mailingAddress: o.mailingAddress, phone: o.phone, website },
    optOutLine: `Don't want mail from us? Visit ${website}/optout or call ${inbound}.`,
    scoreId: r.score_id,
    reportId: r.id,
  };
}

const LETTER_CSS = `
*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#14181F}
body{font:11pt/1.42 Inter,system-ui,sans-serif}
h1,h2{font-family:"Space Grotesk",Inter,sans-serif;margin:0}
.sheet{width:8.5in;height:11in;padding:0 0.7in 0.5in;display:flex;flex-direction:column;overflow:hidden}
/* Top of page one is kept clear for the address the mail provider stamps (double-window envelope). Only the mark sits at the far right. */
.addr{height:3.55in;display:flex;justify-content:flex-end;align-items:flex-start;padding-top:0.55in}
.brand{display:flex;align-items:center;gap:8px;font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:13pt}
h1{font-size:17pt;line-height:1.2;margin-bottom:0.14in}
.meta{font-size:9pt;color:#4A5361;margin-bottom:0.16in}
.f{display:grid;grid-template-columns:0.3in 1fr;gap:6px;margin-bottom:0.09in}
.f .n{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:14pt;color:#1F4FD8;line-height:1}
.f .t{font-weight:600}.f .d{font-size:8.5pt;color:#4A5361}
.named{background:#F3F5F8;border-radius:8px;padding:8px 12px;font-size:10pt;margin:0.06in 0 0.14in}
.cta{display:grid;grid-template-columns:1.55in 1fr;gap:0.25in;align-items:center;border:1.5pt solid #14181F;border-radius:10px;padding:0.14in 0.2in;margin-top:auto}
.cta svg{width:1.55in;height:1.55in;display:block}
.cta .big{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:13pt;line-height:1.25}
.cta .url{font-family:ui-monospace,Menlo,monospace;font-size:12pt;font-weight:700;margin:4px 0}
.foot{font-size:8.5pt;color:#4A5361;border-top:1px solid #C9D1DC;margin-top:0.14in;padding-top:0.08in}
.card{width:6in;height:4in;padding:0.3in;display:grid;grid-template-columns:1fr 1.5in;gap:0.2in;overflow:hidden}
.card h1{font-size:13pt}.card svg{width:1.5in;height:1.5in}.card .foot{font-size:7pt;grid-column:1 / span 2;margin:0}
`;

async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#14181F", light: "#FFFFFF" } });
}

function shell(body: string, page: string): string {
  return `<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><title>Letter</title><style>${embeddedFonts()}${LETTER_CSS}@page{size:${page};margin:0}</style></head><body>${body}</body></html>`;
}

export async function renderLetter(d: LetterData): Promise<string> {
  const qr = await qrSvg(d.qrUrl);
  const foot = `<div class="foot">${esc(d.owner.name)} · ${esc(d.owner.businessName)} · ${esc(d.owner.mailingAddress)} · ${esc(d.owner.phone)} · ${esc(d.owner.website)}<br>${esc(d.optOutLine)}</div>`;
  if (d.kind === "postcard") {
    return shell(`<div class="card">
  <div><div class="brand">${markSvg({ width: 20 })}In The Answer</div>
    <h1 style="margin-top:0.12in">${esc(d.headline)}</h1>
    <p style="font-size:9.5pt;margin:6px 0">Tested ${esc(d.testDate)}. Scan to see your results, or type <strong>${esc(d.typedUrl)}</strong>.<br>Or call ${esc(d.inboundNumber)} to hear your results explained.</p></div>
  <div role="img" aria-label="QR code to your results">${qr}</div>
  ${foot}
</div>`, "6in 4in");
  }
  return shell(`<div class="sheet">
  <div class="addr"><div class="brand">${markSvg({ width: 24 })}In The Answer</div></div>
  <h1>${esc(d.headline)}</h1>
  <div class="meta">To the practice owner, ${esc(d.clinicName)}. Tested ${esc(d.testDate)} with ${esc(d.assistant)}. This is what the assistant answered that day; answers change over time.</div>
  ${d.findings.map((f, i) => `<div class="f"><div class="n">${i + 1}</div><div><span class="t">${esc(f.title)}.</span> ${esc(f.text)} <span class="d">Checked ${esc(f.date)}.</span></div></div>`).join("")}
  ${d.namedInstead.length ? `<div class="named"><strong>Clinics the assistant recommended in these answers:</strong> ${esc(d.namedInstead.join(", "))}.</div>` : ""}
  <div class="cta">
    <div role="img" aria-label="QR code to your results">${qr}</div>
    <div><div class="big">Scan to see your full results and request a short call.</div>
      <div class="url">${esc(d.typedUrl)}</div>
      <div>Or call ${esc(d.inboundNumber)} to hear your results explained.</div></div>
  </div>
  ${foot}
</div>`, "8.5in 11in");
}

/** Everything a reader sees, as plain text, for the letter-only rules. */
export function letterText(d: LetterData): string {
  return [d.headline, ...d.findings.map((f) => `${f.title}. ${f.text}`), d.namedInstead.join(", ")].join("\n");
}

export interface LetterGate {
  flags: Flag[];
  passed: boolean;
  removed: { what: string; why: string }[];
}

/**
 * Gate for a mail piece: the stored teaser is re-verified against its evidence
 * (same gate as email), then the letter itself must match the verified teaser
 * and pass the letter-only rules.
 */
export async function gateLetter(d: LetterData, opts: { live: boolean; verifier?: ModelVerifier; withModel?: boolean } = { live: false }): Promise<LetterGate> {
  const sql = db();
  const [r] = await sql<{ data: TeaserData }[]>`select data from reports where id=${d.reportId}`;
  const v = await verifyTeaser({
    data: r.data, draft: { subject: "", bodyText: "", claims: [] }, scoreId: d.scoreId, live: opts.live,
    withModel: opts.withModel ?? true, verifier: opts.verifier ?? claudeVerifier, skipEmail: true,
  });
  const flags: Flag[] = v.flags.filter((f) => f.code !== "owner_details_placeholder");
  const block = (code: string, message: string) => flags.push({ code, message, severity: "block" });

  // the letter must say exactly what the verified teaser says
  const ok = v.data;
  const expected = headlineFor(d.headlineVariant, { assistant: ok.test.assistant, total: ok.score.total, recommended: ok.score.recommended, city: ok.clinic.city, clinic: ok.clinic.name });
  if (d.headline !== expected) block("letter_headline_unsupported", "the headline does not match the stored test result");
  for (const f of d.findings) {
    if (!ok.findings.some((x) => x.text === f.text)) block("letter_finding_unsupported", `finding not supported by stored evidence: "${f.text.slice(0, 80)}"`);
    if (f.date !== ok.test.date) block("letter_date_mismatch", "a finding's date does not match the test date");
  }
  if (d.kind === "letter" && d.findings.length !== 3) block("letter_needs_three_findings", `the letter has ${d.findings.length} finding(s); it needs three`);
  const recommended = new Set(ok.rows.flatMap((row) => row.namedInstead));
  for (const n of d.namedInstead) if (!recommended.has(n)) block("letter_named_unsupported", `"${n}" was not recommended in the stored answers`);

  // letter-only rules
  const text = letterText(d);
  flags.push(...scanLanguage(text, "letter"));
  if (/\$\s?\d|\b\d+(\.\d+)?\s?(CAD|dollars)\b|\bper month\b/i.test(text)) block("letter_price", "the letter mentions a price");
  if (/\b\d+(\.\d)?\s*(stars?|reviews?|ratings?)\b/i.test(text)) block("review_number_stored", "review numbers may not be printed");
  const identity = [d.owner.name, d.owner.businessName, d.owner.mailingAddress, d.owner.phone, d.inboundNumber].join(" ");
  if (OWNER_PLACEHOLDER_RE.test(identity)) {
    flags.push({ code: "owner_details_placeholder", message: "your name, business name, address, phone or the inbound number is still a placeholder", severity: opts.live ? "block" : "warn" });
  }
  if (!/optout/.test(d.optOutLine)) block("letter_no_optout", "the opt-out line is missing");
  if (!d.qrUrl.includes(`/r/${d.code}`)) block("letter_bad_code", "the QR code does not point to this clinic's page");
  return { flags, passed: !flags.some((f) => f.severity === "block"), removed: v.removed };
}
