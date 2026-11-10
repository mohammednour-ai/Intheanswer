import { db } from "../db";
import { documentShell, esc } from "./html";
import { reportHeader, copilotByline } from "./renderTeaser";
import { CHECK_LABELS, type Evidence } from "../pipeline/audit/types";
import { SITE_CHECK_LABELS, A11Y_LABEL } from "../sitetest/types";
import { LIVE_REVIEWS_MARKER } from "../reviews/liveTable";
import { levelLabel } from "../reviews/thresholds";
import { reviewKitHtml } from "../reviews/kit";
import { fetchLiveRatings } from "../reviews/placesLive";
import { isLowVolume } from "../reviews/thresholds";
import type { PageDraft } from "../pages/draft";
import { ownerDetails } from "../env";
import { formatLongDate } from "../time";

/**
 * Full report (paid). Layout follows the owner's design canvas ("Full report").
 * Sections are included only when their data exists; a step that failed is
 * omitted, never filled with guesses.
 */

export const FIXES: Record<string, string> = {
  questions_answered: "Question and answer pages for each unanswered question (see proposed pages).",
  new_patients: "One-sentence new-patient statement for the home and services pages.",
  hours: "A single hours block used on every page and listing.",
  hours_conflict: "Replace both versions with one hours block; update every directory listing to match.",
  fees: "Fees and coverage statement template with [FEE] placeholders.",
  insurance_billing: "Insurance and direct billing statement template.",
  practitioners: "Team section with names, roles and college registration, once confirmed.",
  languages: "One line listing languages spoken, once confirmed.",
  areas_served: "One line listing areas served, once confirmed.",
  address_on_home: "Footer block with address and phone as text on every page.",
  meta_description: "A written page description for the home page.",
  outdated_notices: "Remove the notice; add a dated notices area for future closures.",
  structured_data: "Structured data block built from confirmed facts (below).",
  directory_consistency: "Directory correction list: the same name, address, phone and hours everywhere.",
  contact_email_own_domain: "Steps to set up an address on your own domain.",
  ai_crawlers: "robots.txt lines that allow the AI crawlers.",
  "site:booking_path": "A booking button and tap-to-call phone link in the header of every page.",
  "site:mobile_layout": "Layout fixes for phones: viewport tag, wider tap targets, no sideways scrolling.",
  "site:speed_mobile": "Image compression and fewer blocking scripts on the home page.",
  "site:speed_desktop": "Image compression and fewer blocking scripts on the home page.",
  "site:https": "Redirect every http:// address to https://.",
  "site:broken_links": "List of broken links with the correct targets.",
  "site:crawl_real_text": "Put key facts (hours, address, services) in the page as text, not only added by scripts or images.",
  "site:accessibility": `Fixes for each issue found (${A11Y_LABEL}).`,
  "site:crawl_ai_bots": "robots.txt lines that allow the AI crawlers.",
  "site:mixed_content": "Load every file over https://.",
  "site:broken_images": "Replace or remove the missing images.",
  "site:alt_text": "Short text descriptions for each image.",
  "site:titles_descriptions": "A unique title and description for each page.",
  "site:heading_order": "One main heading per page, then headings in order.",
  "site:crawl_robots_sitemap": "A sitemap listed in robots.txt.",
};

export interface FullReportData {
  clinic: { id: string; name: string; city: string; domain: string; placeId: string | null };
  score: { recommended: number; total: number } | null;
  testDate: string | null;
  findings: { key: string; label: string; seen: string; fix: string; evidence: Evidence[] }[];
  siteTest: { pages: number; source: string | null; checks: { key: string; label: string; result: string; line: string }[] } | null;
  reviews: { level: string; total: number; average: number | null; count90d: number | null; replyRate: number | null; latest: string | null;
    themes: { kind: string; theme: string; mentions: number }[] } | null;
  pages: { title: string; kind: string; status: string; plannedMonth: string | null; reason: string; targetQuestion: string }[];
  firstDraft: PageDraft | null;
  structuredData: Record<string, unknown> | null;
  kitHtml: string | null;
  regulatorNote: string;
}

export async function buildFullReportData(clinicId: string): Promise<FullReportData> {
  const sql = db();
  const [c] = await sql<{ name: string; site_name: string | null; city: string; domain: string; place_id: string | null; reg: string; sector: string;
    website: string; phone: string | null; address: string | null; phone_confirmed_on_site: boolean; address_confirmed_on_site: boolean }[]>`
    select c.name, c.site_name, ci.name as city, c.domain, c.place_id, se.regulator_note as reg, se.slug as sector, c.website,
           c.phone, c.address, c.phone_confirmed_on_site, c.address_confirmed_on_site
    from clinics c join cities ci on ci.id=c.city_id join sectors se on se.id=c.sector_id where c.id=${clinicId}`;
  const name = c.site_name ?? c.name;
  const [sc] = await sql<{ recommended: number; total: number; finished_at: Date | null }[]>`
    select s.recommended, s.total, t.finished_at from scores s join test_runs t on t.id=s.test_run_id
    where s.clinic_id=${clinicId} order by s.created_at desc limit 1`;
  const audit = await sql<{ check_key: string; summary: string; finding_text: string | null; evidence: Evidence[]; severity: number }[]>`
    select ac.check_key, ac.summary, ac.finding_text, ac.evidence, ac.severity from audit_checks ac join audits a on a.id=ac.audit_id
    where a.clinic_id=${clinicId} and not a.superseded and ac.is_gap and ac.result <> 'could_not_verify' order by ac.severity desc`;
  const [run] = await sql<{ id: string; pages_crawled: number; perf_source: string | null }[]>`
    select id, pages_crawled, perf_source from site_test_runs where clinic_id=${clinicId} and status='done' order by finished_at desc limit 1`;
  const site = run
    ? await sql<{ check_key: string; result: string; line: string; finding_text: string | null; evidence: Evidence[]; impact: number }[]>`
        select check_key, result::text, line, finding_text, evidence, impact from site_test_checks where run_id=${run.id}
        order by case result when 'needs_work' then 0 when 'pass' then 1 else 2 end, impact desc`
    : [];
  const findings = [
    ...audit.map((a) => ({ key: a.check_key, label: CHECK_LABELS[a.check_key] ?? a.check_key, seen: a.finding_text ?? a.summary, fix: FIXES[a.check_key] ?? "", evidence: a.evidence, w: a.severity })),
    ...site.filter((s) => s.result === "needs_work").map((s) => ({ key: `site:${s.check_key}`, label: SITE_CHECK_LABELS[s.check_key] ?? s.check_key, seen: s.finding_text ?? s.line, fix: FIXES[`site:${s.check_key}`] ?? "", evidence: s.evidence, w: Math.round(s.impact * 0.95) })),
  ].sort((a, b) => b.w - a.w);

  const [snap] = await sql<{ id: string; analysis_level: string; total_count: number; average_rating: number | null; count_90d: number | null; reply_rate: number | null; latest_review_at: Date | null }[]>`
    select id, analysis_level, total_count, average_rating, count_90d, reply_rate, latest_review_at from review_snapshots
    where clinic_id=${clinicId} order by created_at desc limit 1`;
  const themes = snap ? await sql<{ kind: string; theme: string; mentions: number }[]>`select kind, theme, mentions from review_themes where snapshot_id=${snap.id} order by mentions desc` : [];

  const pages = await sql<{ title: string; kind: string; status: string; planned_month: string | null; reason: string; target_question: string }[]>`
    select title, kind, status::text, planned_month, reason, target_question from answer_pages where clinic_id=${clinicId} and status <> 'rejected' order by planned_month nulls last, priority desc`;
  const [first] = await sql<{ content: PageDraft }[]>`
    select v.content from answer_pages p join answer_page_versions v on v.page_id=p.id
    where p.clinic_id=${clinicId} order by p.priority desc, v.version desc limit 1`;

  const orgType = c.sector === "dental" ? "Dentist" : c.sector === "family" ? "MedicalClinic" : "MedicalBusiness";
  const structuredData = {
    "@context": "https://schema.org",
    "@type": orgType,
    name,
    url: c.website,
    telephone: c.phone_confirmed_on_site && c.phone ? c.phone : "[PHONE]",
    address: c.address_confirmed_on_site && c.address ? c.address : "[STREET ADDRESS, CITY, POSTAL CODE]",
    openingHours: "[FROM THE SINGLE HOURS BLOCK, once confirmed]",
  };

  // review-request kit when review volume is low: decided from a live count, which is never stored
  let kitHtml: string | null = null;
  if (snap && isLowVolume(snap.total_count) && c.place_id) kitHtml = (await reviewKitHtml(name, c.place_id)).html;
  else if (!snap && c.place_id) {
    const live = await fetchLiveRatings([c.place_id], clinicId);
    if (live?.[0]?.count != null && isLowVolume(live[0].count)) kitHtml = (await reviewKitHtml(name, c.place_id)).html;
  }

  return {
    clinic: { id: clinicId, name, city: c.city, domain: c.domain, placeId: c.place_id },
    score: sc ? { recommended: sc.recommended, total: sc.total } : null,
    testDate: sc?.finished_at ? formatLongDate(sc.finished_at) : null,
    findings: findings.map((f) => ({ key: f.key, label: f.label, seen: f.seen, fix: f.fix, evidence: f.evidence })),
    siteTest: run ? { pages: run.pages_crawled, source: run.perf_source, checks: site.map((s) => ({ key: s.check_key, label: SITE_CHECK_LABELS[s.check_key] ?? s.check_key, result: s.result, line: s.line })) } : null,
    reviews: snap
      ? { level: snap.analysis_level, total: snap.total_count, average: snap.average_rating, count90d: snap.count_90d, replyRate: snap.reply_rate,
          latest: snap.latest_review_at ? formatLongDate(snap.latest_review_at) : null, themes }
      : null,
    pages: pages.map((p) => ({ title: p.title, kind: p.kind, status: p.status, plannedMonth: p.planned_month, reason: p.reason, targetQuestion: p.target_question })),
    firstDraft: first?.content ?? null,
    structuredData,
    kitHtml,
    regulatorNote: c.reg,
  };
}

const RESULT_TEXT: Record<string, string> = { pass: "Pass", needs_work: "Needs work", could_not_test: "Could not test" };

export function renderFullReport(d: FullReportData, opts: { web: boolean }): string {
  const o = ownerDetails();
  const findingRows = d.findings
    .map((f) => `<tr><td style="font-weight:600">${esc(f.label)}</td><td>${esc(f.seen)}</td><td>${esc(f.fix)}</td></tr>`)
    .join("");
  const site = d.siteTest
    ? `<section><h2>Full site test</h2>
  <p class="key">${d.siteTest.pages} pages crawled (limit 40, robots.txt respected). Speed: ${d.siteTest.source === "pagespeed" ? "PageSpeed Insights" : d.siteTest.source === "lighthouse_local" ? "Lighthouse lab test from our server (no real-visitor data)" : "not measured"}. Accessibility: ${A11Y_LABEL}. Sorted by patient impact; "could not test" means the check could not be run, not that something is wrong.</p>
  <div class="table-wrap"><table><thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">What we saw</th></tr></thead><tbody>
  ${d.siteTest.checks.map((c) => `<tr><td>${esc(c.label)}</td><td class="st ${c.result === "needs_work" ? "st-listed_only" : c.result === "pass" ? "st-recommended" : "none"}">${RESULT_TEXT[c.result]}</td><td>${esc(c.line)}</td></tr>`).join("")}
  </tbody></table></div></section>`
    : "";
  const reviews = d.reviews
    ? `<section><h2>Reviews from your Google Business Profile</h2>
  <p>${d.reviews.total} reviews, average ${d.reviews.average ?? "n/a"}${d.reviews.latest ? `, latest on ${esc(d.reviews.latest)}` : ""}; ${d.reviews.count90d ?? "n/a"} in the last 90 days; owner replies on ${d.reviews.replyRate == null ? "n/a" : Math.round(d.reviews.replyRate * 100) + "%"} of reviews. Analysis: ${esc(levelLabel(d.reviews.level as never))}.</p>
  ${d.reviews.level === "none" ? `<p>With fewer than 10 reviews there is too little text to analyse. The low count is the finding.</p>` : ""}
  ${["praise", "complaint", "service"].map((k) => {
        const t = d.reviews!.themes.filter((x) => x.kind === k);
        return t.length ? `<p><strong>${k === "praise" ? "What patients praise" : k === "complaint" ? "What patients raise as problems" : "Services patients mention"}${d.reviews!.level === "light" ? " (small sample)" : ""}:</strong> ${t.map((x) => `${esc(x.theme)} (${x.mentions})`).join(", ")}</p>` : "";
      }).join("")}
  </section>`
    : opts.web
      ? LIVE_REVIEWS_MARKER
      : "";
  const pages = d.pages.length
    ? `<section><h2>Pages your site is missing</h2>
  <div class="table-wrap"><table><thead><tr><th scope="col">Proposed page</th><th scope="col">Why</th><th scope="col">Planned</th></tr></thead><tbody>
  ${d.pages.map((p) => `<tr><td><strong>${esc(p.title)}</strong><div class="key">${p.kind === "question" ? "Answers" : "Targets"}: ${esc(p.targetQuestion)}</div></td><td>${esc(p.reason)}</td><td>${esc(p.plannedMonth ?? "")}</td></tr>`).join("")}
  </tbody></table></div></section>`
    : "";
  const draft = d.firstDraft
    ? `<section><h2>Sample: the first page, drafted in full</h2>
  <div class="finding" style="gap:8px"><div class="t" style="font-size:16px">${esc(d.firstDraft.title)}</div>
  <p><strong>${esc(d.firstDraft.directAnswer.join(" "))}</strong></p>
  <ul style="margin:0;padding-left:18px">${d.firstDraft.details.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
  <p>${esc(d.clinic.name)} · ${esc(d.firstDraft.contact.address)} · ${esc(d.firstDraft.contact.phone)}<br>Hours: ${esc(d.firstDraft.contact.hours)}</p></div>
  <pre class="file">${esc(JSON.stringify(d.firstDraft.jsonLd, null, 2))}</pre>
  <p class="key">${d.firstDraft.placeholders.length} item(s) in brackets for the clinic to confirm. ${d.firstDraft.reviewerNotes.map(esc).join(" ")}</p></section>`
    : "";
  const body = `<div class="page">
${reportHeader("AI Visibility Report · Full report and fix files")}
<div class="row" style="align-items:flex-end">
  <div class="who"><h1>${esc(d.clinic.name)}</h1><div class="meta">${esc(d.clinic.city)}, Ontario${d.testDate ? ` · Tested ${esc(d.testDate)}` : ""}</div></div>
  ${d.score ? `<div class="score" style="flex:0 0 auto;padding:10px 16px"><div class="label">In the answer</div><div class="num" style="font-size:26px">${d.score.recommended} of ${d.score.total}</div></div>` : ""}
</div>
<section><h2>Every finding, with the fix</h2>
  <div class="table-wrap"><table><thead><tr><th scope="col" style="width:22%">Finding</th><th scope="col" style="width:42%">What we saw</th><th scope="col">Fix in this pack</th></tr></thead><tbody>${findingRows}</tbody></table></div>
</section>
${site}
${reviews}
${pages}
${draft}
<section><h2>Your fix files</h2>
  <div class="finding"><div class="t">Structured data for your site</div><pre class="file">${esc(JSON.stringify(d.structuredData, null, 2))}</pre></div>
  ${d.kitHtml ? `<div class="finding">${d.kitHtml}</div>` : ""}
</section>
<section class="offer main" style="gap:12px">
  <div class="row"><div><div class="label">Next step · Monthly plan</div><div class="price" style="font-size:22px">These files fix today. The monthly plan keeps you in the answer.</div></div><div class="price">200 CAD <span>per month</span></div></div>
  <ul><li>We install everything: your website rebuilt or upgraded with every fix in place.</li><li>Two new answer pages each month, written for the questions patients ask.</li><li>Monthly retest of the same questions, with a before and after.</li><li>Competitor watch: which clinics were named beside you.</li></ul>
  <a class="btn" href="https://intheanswer.ca/pricing">Start the monthly plan</a>
</section>
<footer class="foot">
  ${copilotByline(o.name)}
  <div>This report reflects one assistant, the questions listed, on the test date. Assistants change what they recommend, and results can differ between assistants. These fixes make your clinic easier to understand and quote. No one can guarantee that a clinic will be named.</div>
  <div>All wording for your site is a draft. Please confirm every fact before publishing. ${esc(d.regulatorNote)}</div>
  <div>In The Answer · intheanswer.ca · ${esc(o.name)} · ${esc(o.businessName)} · ${esc(o.mailingAddress)} · ${esc(o.phone)} · ${esc(o.email)}</div>
</footer>
</div>`;
  return documentShell(`${d.clinic.name}: full report`, body);
}
