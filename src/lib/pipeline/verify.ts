import { z } from "zod";
import { db } from "../db";
import { structured, type UsageLike } from "../adapters/claude";
import { parsePage, textContains } from "../site/parse";
import { OWNER_PLACEHOLDER_RE } from "../env";
import type { NamedClinic } from "./match";
import type { Evidence } from "./audit/types";
import type { Claim, TeaserData } from "../reports/types";
import type { Draft } from "../emails/firstEmail";

/**
 * Step 7: verification before sending. Runs in both modes.
 *
 * 1. Deterministic pass: every number, every clinic named instead, and every
 *    finding is re-derived from stored evidence; every quote is re-found in
 *    the stored page or answer text. Anything that does not match is removed.
 * 2. Language pass: banned wording (superlatives, promises, urgency) and
 *    owner placeholders.
 * 3. Model pass: a separate, strict reading of every sentence against its
 *    evidence. Unsupported findings are removed; any other unsupported
 *    sentence holds the clinic.
 *
 * Hold when fewer than three findings survive, or anything not verified is
 * stated as fact.
 */

export interface Flag {
  code: string;
  message: string;
  severity: "block" | "warn";
}

export interface VerifyResult {
  data: TeaserData;
  draft: Draft;
  flags: Flag[];
  removed: { what: string; why: string }[];
  passed: boolean; // no blocking flags
  /** Names and quoted text taken from stored data; pass to scanLanguage when scanning text rebuilt from this result. */
  exclude: ScanExclusions;
  usage: UsageLike | null;
  costUsd: number;
}

const BANNED: { re: RegExp; why: string }[] = [
  { re: /\b(best|top[- ]rated|top|#\s?1|number one|leading|premier|finest|unbeatable)\b/i, why: "superlative" },
  { re: /\b(will|would|going to) (be )?(named|recommended|ranked|appear|show up)\b/i, why: "outcome promise" },
  { re: /\b(rank(ed|ing)? (first|higher|#?1)|get you (ranked|named|recommended))\b/i, why: "ranking promise" },
  { re: /\b(act now|limited time|only \d+ (spots|places)|last chance|hurry|urgent|before it'?s too late|expires? (today|soon))\b/i, why: "fake urgency or scarcity" },
  { re: /\b(worse|inferior|bad|poor|terrible) than\b/i, why: "criticises another clinic" },
];

/** Text that is not ours to word: what the scan must not read as our own claim. */
export interface ScanExclusions {
  /** Proper names known from stored data: the clinic, the clinics an answer named. */
  names?: string[];
  /** Text quoted verbatim from stored data: the patient questions, quotes from the clinic's own pages. */
  quoted?: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Remove known names and known quoted text (and addresses, which are not
 * sentences) from the text before the banned-wording scan. "Premier Dental"
 * or the question "Who is the best dentist in Barrie?" are facts we repeat,
 * not claims we make. Only exact, whole occurrences of strings taken from the
 * data are removed; every other word is still scanned, so "Premier Dental is
 * the premier choice" is still caught.
 */
export function stripKnownText(text: string, ex: ScanExclusions = {}): string {
  let out = text.replace(/\bhttps?:\/\/\S+/gi, " ").replace(/\b[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,24}\b/gi, " ");
  const known = [...(ex.quoted ?? []), ...(ex.names ?? [])]
    .map((s) => (s ?? "").replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 3)
    // a "name" that is nothing but a banned word (a clinic called "Premier") would switch the rule off for that word
    .filter((s) => !BANNED.some((x) => new RegExp(`^(?:${x.re.source})$`, "i").test(s)))
    .sort((a, b) => b.length - a.length); // longest first, so a name inside a quote goes with the quote
  for (const k of [...new Set(known)]) {
    const body = escapeRe(k).replace(/ /g, "\\s+").replace(/['‘’]/g, "['‘’]").replace(/["“”]/g, '["“”]');
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu"), " ");
  }
  return out;
}

export function scanLanguage(textRaw: string, where: string, exclude: ScanExclusions = {}): Flag[] {
  const flags: Flag[] = [];
  const text = stripKnownText(textRaw, exclude);
  const g = text.match(/\bguarantee(d|s)?\b/i);
  if (g && !/(no one can|nobody can|cannot|can't|can not|not) guarantee/i.test(text)) {
    flags.push({ code: "language_guarantee", message: `${where}: uses "guarantee"`, severity: "block" });
  }
  for (const b of BANNED) {
    const m = text.match(b.re);
    if (m) flags.push({ code: "language_" + b.why.replace(/\W+/g, "_"), message: `${where}: ${b.why} ("${m[0]}")`, severity: "block" });
  }
  return flags;
}

async function pageText(url: string): Promise<string | null> {
  const [p] = await db()<{ body: string | null }[]>`select body from page_cache where url=${url}`;
  if (!p?.body) return null;
  return parsePage(url, p.body).text;
}

async function quoteHolds(e: Evidence): Promise<boolean> {
  if (!e.quote || !e.url) return true; // labels without quotes are checked structurally
  if (e.kind === "page_quote") {
    const t = await pageText(e.url);
    return !!t && textContains(t, e.quote);
  }
  if (e.kind === "raw_source") {
    const [p] = await db()<{ body: string | null }[]>`select body from page_cache where url=${e.url}`;
    return !p?.body || p.body.includes(e.quote) || textContains(p.body, e.quote); // not cached: nothing to contradict
  }
  return true;
}

const ModelVerdict = z.object({
  verdicts: z.array(
    z.object({
      id: z.string(),
      supported: z.boolean(),
      issue: z.enum(["none", "unsupported", "overstated", "unverified_as_fact", "superlative_or_promise", "criticises_competitor"]),
      explanation: z.string(),
    }),
  ),
});

const VERIFY_SYSTEM = `You are a strict fact checker for a report sent to a medical or dental clinic. For each sentence you get the stored evidence.
Mark supported=false if the sentence says anything the evidence does not directly show, overstates it (for example "missing" or "does not have" when the evidence only shows it was not found on the pages read), states something as fact that could not be verified, uses superlatives, promises an outcome, or criticises another clinic.
"We did not find X on the pages we read" is supported when the evidence lists the pages read and no quote shows X.
Naming other clinics is fine when they appear in the answer evidence. Be strict: when in doubt, supported=false.`;

export type ModelVerifier = (
  items: { id: string; claim: string; evidence: string }[],
) => Promise<{ verdicts: z.infer<typeof ModelVerdict>["verdicts"]; usage: UsageLike | null; costUsd: number }>;

export const claudeVerifier: ModelVerifier = async (items) => {
  const r = await structured({
    purpose: "verify",
    system: VERIFY_SYSTEM,
    user: items.map((i) => `<claim id="${i.id}">\n<sentence>${i.claim}</sentence>\n<evidence>\n${i.evidence}\n</evidence>\n</claim>`).join("\n\n"),
    schema: ModelVerdict,
    effort: "high",
  });
  return { verdicts: r.data.verdicts, usage: r.usage, costUsd: r.costUsd };
};

export async function verifyTeaser(input: {
  data: TeaserData;
  draft: Draft;
  scoreId: string;
  live: boolean;
  withModel: boolean;
  verifier?: ModelVerifier;
}): Promise<VerifyResult> {
  const sql = db();
  const data: TeaserData = structuredClone(input.data);
  let draft: Draft = structuredClone(input.draft);
  const flags: Flag[] = [];
  const removed: VerifyResult["removed"] = [];

  // --- 1. numbers ---------------------------------------------------------
  const [s] = await sql<{ recommended: number; listed_only: number; total: number; audit_id: string; clinic_id: string; test_run_id: string }[]>`
    select recommended, listed_only, total, audit_id, clinic_id, test_run_id from scores where id=${input.scoreId}`;
  const stored = await sql<{ test_answer_id: string; status: string }[]>`
    select r.test_answer_id, r.status::text from clinic_test_results r join test_answers a on a.id=r.test_answer_id
    where r.clinic_id=${s.clinic_id} and a.test_run_id=${s.test_run_id}`;
  const recCount = stored.filter((x) => x.status === "recommended").length;
  if (data.score.recommended !== recCount || data.score.recommended !== s.recommended || data.score.total !== stored.length) {
    flags.push({ code: "score_mismatch", message: `score ${data.score.recommended}/${data.score.total} does not match stored results ${recCount}/${stored.length}`, severity: "block" });
  }
  for (const row of data.rows) {
    const st = stored.find((x) => x.test_answer_id === row.answerId);
    if (!st || st.status !== row.status) flags.push({ code: "row_status_mismatch", message: `question ${row.questionIndex + 1}: status not supported by stored result`, severity: "block" });
  }

  // --- 2. clinics named instead must be in the answer --------------------------
  for (const row of data.rows) {
    const [a] = await sql<{ answer_text: string; clinics_named: NamedClinic[] }[]>`
      select answer_text, clinics_named from test_answers where id=${row.answerId}`;
    const keep: string[] = [];
    for (const n of row.namedInstead) {
      const rec = a?.clinics_named.find((x) => x.name === n && x.status === "recommended");
      if (rec && textContains(a.answer_text, n)) keep.push(n);
      else removed.push({ what: `"${n}" named instead (question ${row.questionIndex + 1})`, why: "not found as a recommendation in the stored answer" });
    }
    row.namedInstead = keep;
  }

  // --- 3. findings ------------------------------------------------------------
  const checks = await sql<{ check_key: string; result: string; is_gap: boolean; finding_text: string | null }[]>`
    select check_key, result::text, is_gap, finding_text from audit_checks where audit_id=${s.audit_id}`;
  const survivors = [];
  const siteRows = data.siteRunId
    ? await sql<{ check_key: string; result: string; finding_text: string | null }[]>`
        select check_key, result::text, finding_text from site_test_checks where run_id=${data.siteRunId}`
    : [];
  for (const f of data.findings) {
    if (f.checkKey.startsWith("site:")) {
      const key = f.checkKey.slice(5);
      const row = siteRows.find((x) => x.check_key === key);
      if (!row) {
        removed.push({ what: f.title, why: "no stored site test result" });
        continue;
      }
      if (row.result === "could_not_test") {
        removed.push({ what: f.title, why: "site check could not be tested; it may never be stated as a problem" });
        flags.push({ code: "unverified_as_fact", message: `${f.title}: could not be tested but was used as a finding`, severity: "block" });
        continue;
      }
      if (row.result !== "needs_work" || row.finding_text !== f.text) {
        removed.push({ what: f.title, why: "finding text does not match the stored site test result" });
        continue;
      }
      let okSite = true;
      for (const e of f.evidence) if (!(await quoteHolds(e))) okSite = false;
      if (!okSite) {
        removed.push({ what: f.title, why: "a quoted passage is no longer on the stored page" });
        continue;
      }
      survivors.push(f);
      continue;
    }
    const c = checks.find((x) => x.check_key === f.checkKey);
    if (!c) {
      removed.push({ what: f.title, why: "no stored check" });
      continue;
    }
    if (c.result === "could_not_verify") {
      removed.push({ what: f.title, why: "check could not be verified; it may not be stated as fact" });
      flags.push({ code: "unverified_as_fact", message: `${f.title}: could not be verified but was used as a finding`, severity: "block" });
      continue;
    }
    if (!c.is_gap || c.finding_text !== f.text) {
      removed.push({ what: f.title, why: "finding text does not match the stored check" });
      continue;
    }
    let ok = true;
    for (const e of f.evidence) if (!(await quoteHolds(e))) ok = false;
    if (!ok) {
      removed.push({ what: f.title, why: "a quoted passage is no longer on the stored page" });
      continue;
    }
    survivors.push(f);
  }
  data.findings = survivors;

  // --- 4. model pass ------------------------------------------------------------
  let usage: UsageLike | null = null;
  let costUsd = 0;
  if (input.withModel) {
    const items = await claimsWithEvidence(data, draft);
    const r = await (input.verifier ?? claudeVerifier)(items);
    usage = r.usage;
    costUsd = r.costUsd;
    for (const v of r.verdicts) {
      if (v.supported) continue;
      if (v.id.startsWith("finding-")) {
        const idx = Number(v.id.split("-")[1]);
        const f = data.findings[idx];
        if (f) {
          removed.push({ what: f.title, why: `verifier: ${v.issue}: ${v.explanation}` });
          (f as { _drop?: boolean })._drop = true;
        }
      } else {
        flags.push({ code: `verifier_${v.issue}`, message: `${v.id}: ${v.explanation}`, severity: "block" });
      }
    }
    data.findings = data.findings.filter((f) => !(f as { _drop?: boolean })._drop);
    // every claim must get a verdict
    const missing = items.filter((i) => !r.verdicts.some((v) => v.id === i.id));
    if (missing.length) flags.push({ code: "verifier_incomplete", message: `verifier skipped ${missing.map((m) => m.id).join(", ")}`, severity: "block" });
  } else {
    flags.push({ code: "model_verification_not_run", message: "the model verification pass did not run", severity: "block" });
  }

  // --- 5. three findings, language, identity -------------------------------------
  if (data.findings.filter((f) => f.source === "site" || f.checkKey.startsWith("site:")).length > 1) {
    flags.push({ code: "too_many_site_findings", message: "the teaser may use at most one finding from the site test", severity: "block" });
  }
  if (data.findings.length < 3) {
    flags.push({ code: "fewer_than_three_findings", message: `only ${data.findings.length} finding(s) survived verification`, severity: "block" });
  }
  const teaserText = [data.summary.join(" "), ...data.findings.map((f) => f.text)].join("\n");
  // Names and quotes that come from stored data are not our wording: the
  // clinic's name, the clinics the answers named (already checked against the
  // stored answers above), the patient questions, and quotes from stored pages.
  const [own] = await sql<{ name: string; site_name: string | null }[]>`select name, site_name from clinics where id=${s.clinic_id}`;
  const exclude: ScanExclusions = {
    names: [data.clinic.name, own?.name ?? "", own?.site_name ?? "", ...data.rows.flatMap((r) => r.namedInstead)],
    quoted: [...data.rows.map((r) => r.question), ...data.findings.flatMap((f) => f.evidence.map((e) => e.quote ?? ""))],
  };
  flags.push(...scanLanguage(teaserText, "report", exclude));
  // the email body is rebuilt from the surviving findings by the caller; scan what we have
  const emailMain = draft.bodyText.split("\n--\n")[0];
  flags.push(...scanLanguage(draft.subject + "\n" + emailMain, "email", exclude));
  const reviewNumber = /\b\d+(\.\d)?\s*(stars?|reviews?|ratings?)\b|\brated \d/i;
  if (reviewNumber.test(draft.subject + "\n" + emailMain) || reviewNumber.test(teaserText)) {
    flags.push({ code: "review_number_stored", message: "review numbers may only appear in the live web table (Google Maps terms), not in the stored report or email", severity: "block" });
  }
  if (!/unsubscribe|stop all emails/i.test(draft.bodyText)) flags.push({ code: "no_unsubscribe", message: "email has no unsubscribe link", severity: "block" });
  if (OWNER_PLACEHOLDER_RE.test(draft.bodyText) || OWNER_PLACEHOLDER_RE.test(JSON.stringify(data.owner))) {
    flags.push({
      code: "owner_details_placeholder",
      message: "owner name, business name, address or phone is still a placeholder",
      severity: input.live ? "block" : "warn",
    });
  }
  // email findings must be the first two surviving report findings
  const emailFindingIds = draft.claims.filter((c) => c.id.startsWith("email-finding-")).map((c) => c.claim);
  if (emailFindingIds.some((t) => !data.findings.slice(0, 2).some((f) => f.text === t))) {
    flags.push({ code: "email_finding_removed", message: "a finding in the email was removed; the email must be rebuilt", severity: "warn" });
  }

  data.claims = data.claims.filter((c) => c.where !== "finding").concat(
    data.findings.map((f, i) => ({ id: `finding-${i}`, where: "finding" as const, claim: f.text, evidence: f.evidence, verified: true })),
  );
  draft = { ...draft };
  return { data, draft, flags, removed, passed: !flags.some((f) => f.severity === "block"), exclude, usage, costUsd };
}

/** Resolve every claim's evidence into text the model can read. */
async function claimsWithEvidence(data: TeaserData, draft: Draft): Promise<{ id: string; claim: string; evidence: string }[]> {
  const sql = db();
  const answerText = new Map<string, string>();
  for (const r of data.rows) {
    const [a] = await sql<{ answer_text: string; question: string }[]>`select answer_text, question from test_answers where id=${r.answerId}`;
    answerText.set(r.answerId, `Question: ${a.question}\nAnswer: ${a.answer_text.slice(0, 4000)}`);
  }
  const render = (ev: (Evidence & { ref?: string })[]) =>
    ev
      .map((e) => {
        if (e.ref && answerText.has(e.ref)) return `[assistant answer] ${answerText.get(e.ref)}${e.label ? `\nRecorded status: ${e.label}` : ""}`;
        if (e.kind === "pages_read") return `[pages read] ${e.label ?? e.url ?? ""}`;
        return `[${e.kind}] ${e.url ?? ""} ${e.quote ? `"${e.quote}"` : ""} ${e.label ?? ""}`.trim();
      })
      .join("\n");
  const out: { id: string; claim: string; evidence: string }[] = [];
  const scoreEvidence = data.rows.map((r) => `Q${r.questionIndex + 1}: ${r.status}`).join("; ");
  out.push({ id: "summary-0", claim: data.summary[0], evidence: `[stored results] ${scoreEvidence}; total questions ${data.rows.length}` });
  out.push({
    id: "summary-1",
    claim: data.summary[1],
    // The counts come from the stored audit and site test, not from the three
    // findings shown: say so, or the verifier compares "14 gaps" with 3 findings.
    evidence:
      `[stored counts, computed from the database] ${data.claims.find((c) => c.id === "summary-1")?.evidence[0]?.label ?? `${data.pagesRead} pages`}. ` +
      `The audit and the site test read different numbers of pages; the sentence uses the larger. The gap count is the number of failed checks in both; ` +
      `only the three most concrete are shown as findings, so fewer findings than gaps is expected:\n${data.findings.map((f) => "- " + f.text).join("\n")}`,
  });
  for (const r of data.rows) {
    out.push({
      id: `row-${r.questionIndex}`,
      claim: `For "${r.question}", ${data.clinic.name} was ${r.status.replace("_", " ")}; clinics recommended instead: ${r.namedInstead.join(", ") || "none"}.`,
      evidence: answerText.get(r.answerId) ?? "",
    });
  }
  data.findings.forEach((f, i) => out.push({ id: `finding-${i}`, claim: f.text, evidence: render(f.evidence) }));
  for (const c of draft.claims.filter((x) => x.id === "email-result")) {
    const tally = new Map<string, number>();
    for (const r of data.rows) for (const n of r.namedInstead) tally.set(n, (tally.get(n) ?? 0) + 1);
    const counts = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n}: ${k}`).join("; ");
    out.push({
      id: c.id,
      claim: c.claim,
      evidence: data.rows.map((r) => `Q${r.questionIndex + 1}: ${r.status}; recommended: ${r.namedInstead.join(", ")}`).join("\n") + `\nTimes each clinic was recommended: ${counts}`,
    });
  }
  return out;
}

export type { Claim };
