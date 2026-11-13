import { db } from "../db";
import { documentShell, esc } from "./html";
import { reportHeader, copilotByline } from "./renderTeaser";
import type { Claim, OwnerFooter, RowStatus } from "./types";
import { SITE_CHECK_LABELS } from "../sitetest/types";
import { diffSnapshots, type SnapshotDiff } from "../reviews/gbp";

/**
 * Monthly report sections for the added services: review numbers versus last
 * month (connected Business Profile only), site test changes, and pages
 * published with whether their target question improved.
 */

export interface SiteChange {
  key: string;
  label: string;
  before: string | null;
  after: string;
  line: string;
}

export function siteTestChanges(prev: { check_key: string; result: string }[], cur: { check_key: string; result: string; line: string }[]): SiteChange[] {
  return cur
    .map((c) => {
      const p = prev.find((x) => x.check_key === c.check_key);
      return { key: c.check_key, label: SITE_CHECK_LABELS[c.check_key] ?? c.check_key, before: p?.result ?? null, after: c.result, line: c.line };
    })
    .filter((c) => c.before !== c.after);
}

const ORDER = { not_named: 0, listed_only: 1, recommended: 2 } as Record<string, number>;
export function pageResultTrend(before: string | null, after: string | null): "improved" | "unchanged" | "lower" | "not tested yet" {
  if (!after) return "not tested yet";
  if (!before) return "unchanged";
  const d = (ORDER[after] ?? 0) - (ORDER[before] ?? 0);
  return d > 0 ? "improved" : d < 0 ? "lower" : "unchanged";
}

export interface MonthlyServices {
  reviews: { current: { total_count: number; average_rating: number | null; count_90d: number | null; reply_rate: number | null }; diff: SnapshotDiff } | null;
  siteChanges: SiteChange[];
  pages: { title: string; liveUrl: string | null; question: string; before: string | null; now: string | null; trend: string }[];
}

/**
 * `runLabel`: when given, review numbers are included only if this run has its
 * own snapshot from the clinic's connected Business Profile (an older snapshot
 * is never shown as this month's).
 */
export async function monthlyServices(clinicId: string, baselineTestRunId: string | null, runLabel?: string): Promise<MonthlyServices> {
  const sql = db();
  const allSnaps = await sql<{ run_label: string; total_count: number; average_rating: number | null; count_90d: number | null; reply_rate: number | null }[]>`
    select run_label, total_count, average_rating, count_90d, reply_rate from review_snapshots
    where clinic_id=${clinicId} and source='gbp' order by created_at desc limit 2`;
  const snaps = runLabel && allSnaps[0]?.run_label !== runLabel ? [] : [...allSnaps];
  const runs = await sql<{ id: string }[]>`select id from site_test_runs where clinic_id=${clinicId} and status='done' order by finished_at desc limit 2`;
  let siteChanges: SiteChange[] = [];
  if (runs.length === 2) {
    const cur = await sql<{ check_key: string; result: string; line: string }[]>`select check_key, result::text, line from site_test_checks where run_id=${runs[0].id}`;
    const prev = await sql<{ check_key: string; result: string }[]>`select check_key, result::text from site_test_checks where run_id=${runs[1].id}`;
    siteChanges = siteTestChanges(prev, cur);
  }
  const pages = await sql<{ title: string; live_url: string | null; target_question: string; question_index: number | null; latest_test_status: string | null }[]>`
    select title, live_url, target_question, question_index, latest_test_status::text from answer_pages where clinic_id=${clinicId} and status='live'`;
  const baseline = baselineTestRunId
    ? await sql<{ question_index: number; status: string }[]>`
        select a.question_index, r.status::text from test_answers a join clinic_test_results r on r.test_answer_id=a.id and r.clinic_id=${clinicId}
        where a.test_run_id=${baselineTestRunId}`
    : [];
  return {
    reviews: snaps.length ? { current: snaps[0], diff: diffSnapshots(snaps[1] ?? null, snaps[0]) } : null,
    siteChanges,
    pages: pages.map((p) => {
      const before = baseline.find((b) => b.question_index === p.question_index)?.status ?? null;
      return { title: p.title, liveUrl: p.live_url, question: p.target_question, before, now: p.latest_test_status, trend: pageResultTrend(before, p.latest_test_status) };
    }),
  };
}

const sign = (n: number | null, d = 0) => (n == null ? "n/a" : `${n > 0 ? "+" : ""}${d ? n.toFixed(d) : n}`);
const RES: Record<string, string> = { pass: "pass", needs_work: "needs work", could_not_test: "could not test" };

export function renderMonthlyServices(m: MonthlyServices): string {
  const r = m.reviews
    ? `<section><h2>Reviews this month</h2><table><tbody>
<tr><td>Total reviews</td><td>${m.reviews.current.total_count}</td><td>${sign(m.reviews.diff.totalChange)} since last month</td></tr>
<tr><td>Average rating</td><td>${m.reviews.current.average_rating ?? "n/a"}</td><td>${sign(m.reviews.diff.averageChange, 2)}</td></tr>
<tr><td>Reviews in the last 90 days</td><td>${m.reviews.current.count_90d ?? "n/a"}</td><td>${sign(m.reviews.diff.count90dChange)}</td></tr>
<tr><td>Owner reply rate</td><td>${m.reviews.current.reply_rate == null ? "n/a" : Math.round(m.reviews.current.reply_rate * 100) + "%"}</td><td>${m.reviews.diff.replyRateChange == null ? "n/a" : sign(Math.round(m.reviews.diff.replyRateChange * 100)) + " points"}</td></tr>
</tbody></table></section>`
    : "";
  const s = `<section><h2>Site test changes</h2>${
    m.siteChanges.length
      ? `<table><thead><tr><th scope="col">Check</th><th scope="col">Last month</th><th scope="col">Now</th></tr></thead><tbody>${m.siteChanges
          .map((c) => `<tr><td>${esc(c.label)}<div class="key">${esc(c.line)}</div></td><td>${c.before ? RES[c.before] : "new"}</td><td>${RES[c.after]}</td></tr>`)
          .join("")}</tbody></table>`
      : `<p>No site test results changed since last month.</p>`
  }</section>`;
  const p = m.pages.length
    ? `<section><h2>Pages published and their questions</h2><table><thead><tr><th scope="col">Page</th><th scope="col">Before the page</th><th scope="col">This month</th></tr></thead><tbody>${m.pages
        .map((x) => `<tr><td>${x.liveUrl ? `<a href="${esc(x.liveUrl)}">${esc(x.title)}</a>` : esc(x.title)}<div class="key">${esc(x.question)}</div></td><td>${esc((x.before ?? "n/a").replace("_", " "))}</td><td>${esc((x.now ?? "not tested yet").replace("_", " "))} (${x.trend})</td></tr>`)
        .join("")}</tbody></table></section>`
    : "";
  return r + s + p;
}

// ---------------------------------------------------------------------------
// The monthly report (subscribers) and the retest report (some weeks after a
// one-time purchase): the same questions now and at the previous test.
// ---------------------------------------------------------------------------

export interface ComparisonRow {
  questionIndex: number;
  question: string;
  answerId: string;
  now: RowStatus;
  /** Result at the previous test; null when there is no stored result for the same question. */
  before: RowStatus | null;
  previousAnswerId: string | null;
}

export interface ComparisonData {
  kind: "monthly" | "retest";
  verified: boolean;
  cycle: string;                    // monthly: YYYY-MM; retest: the run label
  grace?: boolean;                  // monthly: run while the subscription was past due
  orderId?: string;                 // retest: the one-time order
  clinic: { id: string; name: string; city: string; domain: string | null };
  test: { assistant: string; model: string; date: string; runLabel: string; testRunId: string };
  score: { id: string; auditId: string; recommended: number; listedOnly: number; total: number };
  previous: {
    reportId: string | null; reportKind: string | null; scoreId: string; testRunId: string; auditId: string;
    recommended: number; listedOnly: number; total: number; date: string;
  } | null;
  rows: ComparisonRow[];
  /** Answer pages that went live since the previous report. */
  installed: { pageId: string; title: string; liveUrl: string | null; question: string; wentLive: string }[];
  /** Findings of the previous audit that the current audit no longer reports. */
  fixed: { key: string; label: string; before: string; now: string }[];
  services: MonthlyServices;
  summary: string[];
  offer: { monthlyUrl: string } | null;
  limits: string;
  owner: OwnerFooter;
  claims: Claim[];
  removed?: { what: string; why: string }[];
}

const STATUS_TEXT: Record<string, string> = { recommended: "Recommended", listed_only: "Listed only", not_named: "Not named" };

export function rowTrend(r: Pick<ComparisonRow, "before" | "now">): "improved" | "lower" | "unchanged" | "no earlier result" {
  if (!r.before) return "no earlier result";
  const t = pageResultTrend(r.before, r.now);
  return t === "improved" || t === "lower" ? t : "unchanged";
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The summary lines, built only from what is in the data, so they are rebuilt after verification. */
export function comparisonSummary(d: Omit<ComparisonData, "summary">): string[] {
  const out = [`On ${d.test.date}, ${d.clinic.name} was recommended in ${d.score.recommended} of ${d.score.total} answers.`];
  if (d.previous) out.push(`At the previous test on ${d.previous.date} it was recommended in ${d.previous.recommended} of ${d.previous.total}.`);
  const compared = d.rows.filter((r) => r.before);
  if (compared.length) {
    const up = compared.filter((r) => rowTrend(r) === "improved").length;
    const down = compared.filter((r) => rowTrend(r) === "lower").length;
    out.push(`Of the ${count(compared.length, "question", "questions")} asked both times, ${up} improved, ${down} went lower and ${compared.length - up - down} stayed the same.`);
  }
  if (d.installed.length) out.push(`${count(d.installed.length, "answer page", "answer pages")} went live since the last report.`);
  if (d.fixed.length) out.push(`${count(d.fixed.length, "earlier finding is", "earlier findings are")} no longer found on the site.`);
  return out;
}

export function renderComparisonReport(d: ComparisonData): string {
  const monthly = d.kind === "monthly";
  const rows = d.rows
    .map((r) => `<tr><td>${esc(r.question)}</td><td class="st ${r.before ? `st-${r.before}` : "none"}">${r.before ? STATUS_TEXT[r.before] : "No earlier result"}</td><td class="st st-${r.now}">${STATUS_TEXT[r.now]}</td><td>${esc(rowTrend(r))}</td></tr>`)
    .join("");
  const installed = d.installed.length || d.fixed.length
    ? `<section><h2>${monthly ? "Installed and fixed since the last report" : "What changed on the site since the first report"}</h2>
  ${d.installed.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">Page that went live</th><th scope="col">Question it answers</th><th scope="col">Live since</th></tr></thead><tbody>${d.installed
      .map((p) => `<tr><td>${p.liveUrl ? `<a href="${esc(p.liveUrl)}">${esc(p.title)}</a>` : esc(p.title)}</td><td>${esc(p.question)}</td><td>${esc(p.wentLive)}</td></tr>`)
      .join("")}</tbody></table></div>` : ""}
  ${d.fixed.length ? `<div class="table-wrap"><table><thead><tr><th scope="col" style="width:24%">Finding</th><th scope="col">At the previous test</th><th scope="col">Now</th></tr></thead><tbody>${d.fixed
      .map((f) => `<tr><td style="font-weight:600">${esc(f.label)}</td><td>${esc(f.before)}</td><td>${esc(f.now)}</td></tr>`)
      .join("")}</tbody></table></div>` : ""}
</section>`
    : "";
  const services = monthly
    ? renderMonthlyServices(d.services)
    : d.services.siteChanges.length ? renderMonthlyServices({ reviews: null, siteChanges: d.services.siteChanges, pages: [] }) : "";
  const offer = d.offer
    ? `<section class="offer main" style="gap:12px">
  <div class="row"><div class="label">Full service plan</div><div class="price">200 CAD <span>per month</span></div></div>
  <ul><li>Every fix from your report installed by us</li><li>New answer pages each month, written for the questions patients ask</li><li>The same questions retested every month, with a before and after like this one</li></ul>
  <a class="btn" href="${esc(d.offer.monthlyUrl)}">Start the full service plan</a>
</section>`
    : "";
  const body = `<div class="page">
${reportHeader(monthly ? `AI Visibility Report · Monthly report · ${d.cycle}` : "AI Visibility Report · Retest")}
<div class="who">
  <div class="label">Prepared for</div>
  <h1>${esc(d.clinic.name)}</h1>
  <div class="meta">${esc(d.clinic.city)}, Ontario · Tested ${esc(d.test.date)} · Assistant: ${esc(d.test.assistant)} (${esc(d.test.model)}), web search on</div>
</div>
<div class="hero">
  <div class="score"><div class="label">In the answer</div>
    <div class="num">${d.score.recommended} <span>of ${d.score.total}</span></div>
    <div class="cap">${d.previous ? `previous test: ${d.previous.recommended} of ${d.previous.total} (${esc(d.previous.date)})` : "patient questions where your clinic was recommended"}</div></div>
  <div class="summary">${d.summary.map((s, i) => (i === 0 ? `<div class="head">${esc(s)}</div>` : `<p>${esc(s)}</p>`)).join("")}</div>
</div>
<section>
  <h2>Question by question</h2>
  <div class="table-wrap"><table>
    <thead><tr><th scope="col" style="width:46%">Patient question</th><th scope="col">Previous test</th><th scope="col">This test</th><th scope="col">Change</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <div class="key"><strong>Recommended</strong>: put forward as an option. <strong>Listed only</strong>: mentioned or cited without being recommended. <strong>Not named</strong>: did not appear. "No earlier result" means the question was not asked, or was worded differently, at the previous test.</div>
</section>
${installed}
${services}
${offer}
<footer class="foot">
  ${copilotByline(d.owner.name)}
  <div>${esc(d.limits)}</div>
  <div>In The Answer · intheanswer.ca · ${esc(d.owner.name)} · ${esc(d.owner.businessName)} · ${esc(d.owner.mailingAddress)} · ${esc(d.owner.phone)} · ${esc(d.owner.email)}</div>
</footer>
</div>`;
  return documentShell(`${d.clinic.name}: ${monthly ? `monthly report ${d.cycle}` : "retest"}`, body);
}
