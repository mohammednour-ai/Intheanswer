import { esc } from "../reports/html";
import { INTENTS, SERVICE_TEMPLATE, fill, placeholdersIn, PRESCRIPTION_RE } from "./intents";

/**
 * Draft an answer page. Structure: title phrased as the question, a direct
 * answer in the first two sentences, supporting detail, an hours and contact
 * block, and matching structured data (FAQPage for a question, MedicalWebPage
 * for a service). Facts only from what the clinic's site states verbatim;
 * everything else is a bracketed placeholder.
 */

export interface ClinicFacts {
  name: string;
  city: string;
  sector: string;
  website: string;
  address: string | null; // confirmed on the clinic's own site
  phone: string | null; // confirmed on the clinic's own site
  hoursQuote: { text: string; url: string } | null; // verbatim from the site
  regulatorNote: string;
}

export interface PageDraft {
  title: string;
  directAnswer: [string, string];
  details: string[];
  contact: { address: string; phone: string; hours: string; hoursSource: string | null };
  reviewerNotes: string[];
  jsonLd: Record<string, unknown>;
  placeholders: string[];
  html: string;
  clinicName: string;
}

/** HTML is always rebuilt from fields and escaped (values may come from the clinic). */
export function renderPageHtml(d: Omit<PageDraft, "html">): string {
  return `<article class="answer-page">
<h1>${esc(d.title)}</h1>
<p class="lead">${esc(d.directAnswer[0])} ${esc(d.directAnswer[1])}</p>
<h2>Details</h2>
<ul>${d.details.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<h2>Hours and contact</h2>
<p><strong>${esc(d.clinicName)}</strong><br>${esc(d.contact.address)}<br>Phone: ${esc(d.contact.phone)}<br>Hours: ${esc(d.contact.hours)}</p>
<script type="application/ld+json">${JSON.stringify(d.jsonLd).replace(/</g, "\\u003c")}</script>
</article>`;
}

export function buildDraft(page: { kind: "question" | "service"; intent: string; targetQuestion: string; service: string | null; title: string }, f: ClinicFacts): PageDraft {
  const v = { clinic: f.name, city: f.city, service: page.service ?? "" };
  const t = page.kind === "question" ? INTENTS.find((i) => i.intent === page.intent) : null;
  const tpl = t ?? SERVICE_TEMPLATE;
  const directAnswer = tpl.answer.map((s) => fill(s, v).replaceAll("[PHONE]", f.phone ?? "[PHONE]")) as [string, string];
  const details = tpl.details.map((s) => fill(s, v));
  const contact = {
    address: f.address ?? "[STREET ADDRESS, CITY, POSTAL CODE]",
    phone: f.phone ?? "[PHONE]",
    hours: f.hoursQuote?.text ?? "[ONE HOURS BLOCK, the same on every page and listing]",
    hoursSource: f.hoursQuote?.url ?? null,
  };
  const prescription = PRESCRIPTION_RE.test(page.targetQuestion) || PRESCRIPTION_RE.test(page.service ?? "");
  const reviewerNotes = [
    "Replace every [BRACKETED] item with a confirmed fact, or remove the sentence.",
    f.regulatorNote,
    ...(prescription
      ? ["This page concerns a prescription treatment: describe it factually only. No promotional claims, results, before-and-after promises or offers."]
      : []),
    ...(f.hoursQuote ? [`Hours are copied from ${f.hoursQuote.url}; keep one hours block that matches everywhere.`] : []),
  ];
  const orgType = f.sector === "dental" ? "Dentist" : f.sector === "family" ? "MedicalClinic" : "MedicalBusiness";
  const provider: Record<string, unknown> = {
    "@type": orgType,
    name: f.name,
    url: f.website,
    ...(f.phone ? { telephone: f.phone } : { telephone: "[PHONE]" }),
    ...(f.address ? { address: f.address } : { address: "[STREET ADDRESS, CITY, POSTAL CODE]" }),
  };
  const answerText = directAnswer.join(" ");
  const jsonLd =
    page.kind === "question"
      ? { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: page.title, acceptedAnswer: { "@type": "Answer", text: answerText } }], about: provider }
      : { "@context": "https://schema.org", "@type": "MedicalWebPage", name: page.title, about: { "@type": "MedicalProcedure", name: page.service }, provider, lastReviewed: "[DATE THE CLINIC REVIEWED THIS PAGE]" };
  const placeholders = placeholdersIn(page.title, answerText, ...details, contact.address, contact.phone, contact.hours, JSON.stringify(jsonLd));
  const d = { title: page.title, directAnswer, details, contact, reviewerNotes, jsonLd, placeholders, html: "", clinicName: f.name };
  return { ...d, html: renderPageHtml(d) };
}

/** Fill placeholders with values the clinic provided on the approval page. */
export function applyValues(d: PageDraft, values: Record<string, string>): PageDraft {
  // Only the draft's own placeholders may be filled; values are plain text.
  const allowed = Object.entries(values).filter(([k, v]) => d.placeholders.includes(k) && v.trim());
  const sub = (s: string) => allowed.reduce((acc, [k, v]) => acc.replaceAll(k, v.trim()), s);
  // Structured data is substituted value by value, never through its JSON text,
  // so a quote or backslash in a value cannot break or extend it.
  const deep = (x: unknown): unknown =>
    typeof x === "string" ? sub(x) : Array.isArray(x) ? x.map(deep) : x && typeof x === "object"
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, v]) => [k, deep(v)])) : x;
  const jsonLd = deep(d.jsonLd) as Record<string, unknown>;
  const out: PageDraft = {
    ...d,
    title: sub(d.title),
    directAnswer: d.directAnswer.map(sub) as [string, string],
    details: d.details.map(sub),
    contact: { ...d.contact, address: sub(d.contact.address), phone: sub(d.contact.phone), hours: sub(d.contact.hours) },
    jsonLd,
    html: "",
  };
  out.placeholders = placeholdersIn(out.title, out.directAnswer.join(" "), ...out.details, out.contact.address, out.contact.phone, out.contact.hours, JSON.stringify(jsonLd));
  out.html = renderPageHtml(out);
  return out;
}
