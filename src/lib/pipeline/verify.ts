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

export function scanLanguage(text: string, where: string): Flag[] {
  const flags: Flag[] = [];
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
  /** Verify the report content only (used for letters, which have no email draft). */
  skipEmail?: boolean;
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
  flags.push(...scanLanguage(teaserText, "report"));
  // the email body is rebuilt from the surviving findings by the caller; scan what we have
  const emailMain = draft.bodyText.split("\n--\n")[0];
  if (!input.skipEmail) flags.push(...scanLanguage(draft.subject + "\n" + emailMain, "email"));
  const reviewNumber = /\b\d+(\.\d)?\s*(stars?|reviews?|ratings?)\b|\brated \d/i;
  if (reviewNumber.test(draft.subject + "\n" + emailMain) || reviewNumber.test(teaserText)) {
    flags.push({ code: "review_number_stored", message: "review numbers may only appear in the live web table (Google Maps terms), not in the stored report or email", severity: "block" });
  }
  if (!input.skipEmail && !/unsubscribe|stop all emails/i.test(draft.bodyText)) flags.push({ code: "no_unsubscribe", message: "email has no unsubscribe link", severity: "block" });
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
  return { data, draft, flags, removed, passed: !flags.some((f) => f.severity === "block"), usage, costUsd };
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
    evidence: `[audit] pages read: ${data.pagesRead}; confirmed gaps are the stored findings below.\n${data.findings.map((f) => "- " + f.text).join("\n")}`,
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
    out.push({ id: c.id, claim: c.claim, evidence: data.rows.map((r) => `Q${r.questionIndex + 1}: ${r.status}; recommended: ${r.namedInstead.join(", ")}`).join("\n") });
  }
  return out;
}

export type { Claim };
