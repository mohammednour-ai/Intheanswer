import { db } from "../db";
import { randomToken } from "../tokens";
import { scanLanguage } from "../pipeline/verify";
import { buildDraft, applyValues, type ClinicFacts, type PageDraft } from "./draft";

/**
 * Answer page workflow:
 *   proposed -> draft -> owner_reviewed -> sent_to_clinic -> clinic_approved -> live
 *   sent_to_clinic -> changes_requested -> draft
 *   owner_reviewed -> draft (owner edits)      live -> draft (revision)
 *   any state except live -> rejected
 * Every step is recorded in answer_page_events with who and when.
 */
export type PageStatus = "proposed" | "draft" | "owner_reviewed" | "sent_to_clinic" | "changes_requested" | "clinic_approved" | "live" | "rejected";
export type Actor = "system" | "owner" | "clinic";

const ALLOWED: Record<PageStatus, { to: PageStatus; by: Actor[] }[]> = {
  proposed: [{ to: "draft", by: ["system", "owner"] }, { to: "rejected", by: ["owner"] }],
  draft: [{ to: "owner_reviewed", by: ["owner"] }, { to: "draft", by: ["owner", "system"] }, { to: "rejected", by: ["owner"] }],
  owner_reviewed: [{ to: "sent_to_clinic", by: ["owner"] }, { to: "draft", by: ["owner"] }, { to: "rejected", by: ["owner"] }],
  sent_to_clinic: [{ to: "clinic_approved", by: ["clinic"] }, { to: "changes_requested", by: ["clinic"] }, { to: "rejected", by: ["owner"] }],
  changes_requested: [{ to: "draft", by: ["owner"] }, { to: "rejected", by: ["owner"] }],
  clinic_approved: [{ to: "live", by: ["owner"] }, { to: "draft", by: ["owner"] }, { to: "rejected", by: ["owner"] }],
  live: [{ to: "draft", by: ["owner"] }],
  rejected: [],
};

export function canTransition(from: PageStatus, to: PageStatus, by: Actor): boolean {
  return ALLOWED[from].some((t) => t.to === to && t.by.includes(by));
}

export class WorkflowError extends Error {}

async function move(pageId: string, to: PageStatus, by: Actor, detail?: string, note?: string, extra?: (tx: ReturnType<typeof db>) => Promise<void>) {
  const sql = db();
  await sql.begin(async (tx) => {
    const [p] = await tx<{ status: PageStatus }[]>`select status::text as status from answer_pages where id=${pageId} for update`;
    if (!p) throw new WorkflowError("page not found");
    if (!canTransition(p.status, to, by)) throw new WorkflowError(`cannot move from ${p.status} to ${to} as ${by}`);
    if (extra) await extra(tx as unknown as ReturnType<typeof db>);
    await tx`update answer_pages set status=${to}, updated_at=now() where id=${pageId}`;
    await tx`insert into answer_page_events (page_id, from_status, to_status, actor, actor_detail, note)
             values (${pageId}, ${p.status}, ${to}, ${by}, ${detail ?? null}, ${note ?? null})`;
  });
}

async function latestVersion(pageId: string): Promise<{ version: number; content: PageDraft } | null> {
  const [v] = await db()<{ version: number; content: PageDraft }[]>`
    select version, content from answer_page_versions where page_id=${pageId} order by version desc limit 1`;
  return v ?? null;
}

async function saveVersion(tx: ReturnType<typeof db>, pageId: string, d: PageDraft, by: Actor) {
  const [n] = await tx<{ v: number }[]>`select coalesce(max(version),0)+1 as v from answer_page_versions where page_id=${pageId}`;
  await tx`insert into answer_page_versions (page_id, version, content, html, json_ld, placeholders, created_by)
           values (${pageId}, ${n.v}, ${tx.json(d as never)}, ${d.html}, ${tx.json(d.jsonLd as never)}, ${d.placeholders}, ${by})`;
}

/** Language rules for text meant for the clinic's own site. */
export function draftLanguageFlags(d: PageDraft): string[] {
  const text = [d.title, ...d.directAnswer, ...d.details].join("\n");
  const flags = scanLanguage(text, "page").map((f) => f.message);
  if (/\b(better|faster|cheaper|more experienced) than\b/i.test(text)) flags.push("page: comparison with other clinics");
  return flags;
}

export async function generateDraft(pageId: string, facts: ClinicFacts, by: Actor = "system") {
  const sql = db();
  const [p] = await sql<{ kind: "question" | "service"; intent: string; target_question: string; service: string | null; title: string }[]>`
    select kind, intent, target_question, service, title from answer_pages where id=${pageId}`;
  const d = buildDraft({ kind: p.kind, intent: p.intent, targetQuestion: p.target_question, service: p.service, title: p.title }, facts);
  const flags = draftLanguageFlags(d);
  if (flags.length) throw new WorkflowError(`draft fails language rules: ${flags.join("; ")}`);
  await move(pageId, "draft", by, undefined, "draft generated", (tx) => saveVersion(tx, pageId, d, by));
  return d;
}

export async function ownerEdit(pageId: string, d: PageDraft, ownerEmail: string) {
  const flags = draftLanguageFlags(d);
  if (flags.length) throw new WorkflowError(`edit fails language rules: ${flags.join("; ")}`);
  await move(pageId, "draft", "owner", ownerEmail, "owner edited", (tx) => saveVersion(tx, pageId, d, "owner"));
}

export const ownerApprove = (pageId: string, ownerEmail: string) => move(pageId, "owner_reviewed", "owner", ownerEmail);

export async function sendToClinic(pageId: string, ownerEmail: string): Promise<string> {
  const token = randomToken(18);
  await move(pageId, "sent_to_clinic", "owner", ownerEmail, "approval link created", async (tx) => {
    await tx`update answer_pages set clinic_token=${token} where id=${pageId}`;
  });
  return token;
}

/** Clinic approves on the public link, optionally filling the bracketed facts. */
export async function clinicApprove(token: string, values: Record<string, string>, who: string) {
  const sql = db();
  const [p] = await sql<{ id: string }[]>`select id from answer_pages where clinic_token=${token}`;
  if (!p) throw new WorkflowError("unknown approval link");
  const v = await latestVersion(p.id);
  if (!v) throw new WorkflowError("no draft");
  const filled = applyValues(v.content, values);
  const flags = draftLanguageFlags(filled);
  if (flags.length) throw new WorkflowError(`the wording entered breaks the page rules: ${flags.join("; ")}`);
  await move(p.id, "clinic_approved", "clinic", who.slice(0, 120), `${Object.keys(values).length} fact(s) provided`, async (tx) => {
    if (Object.values(values).some((x) => x.trim())) await saveVersion(tx, p.id, filled, "clinic");
  });
}

export async function clinicRequestChanges(token: string, note: string, who: string) {
  const [p] = await db()<{ id: string }[]>`select id from answer_pages where clinic_token=${token}`;
  if (!p) throw new WorkflowError("unknown approval link");
  await move(p.id, "changes_requested", "clinic", who.slice(0, 120), note.slice(0, 2000));
}

export async function markLive(pageId: string, liveUrl: string, ownerEmail: string) {
  if (!/^https:\/\/\S+$/.test(liveUrl)) throw new WorkflowError("live URL must be an https:// address");
  const v = await latestVersion(pageId);
  if (!v) throw new WorkflowError("no draft");
  if (v.content.placeholders.length) throw new WorkflowError(`${v.content.placeholders.length} placeholder(s) still to confirm: ${v.content.placeholders.slice(0, 3).join(", ")}`);
  await move(pageId, "live", "owner", ownerEmail, liveUrl, async (tx) => {
    await tx`update answer_pages set live_url=${liveUrl} where id=${pageId}`;
  });
}

export const reject = (pageId: string, ownerEmail: string, note?: string) => move(pageId, "rejected", "owner", ownerEmail, note);

/**
 * Monthly run: record the latest test result for each live page's target
 * question (question pages take it from the run's stored result).
 */
export async function updateLivePageResults(clinicId: string, testRunId: string): Promise<number> {
  const sql = db();
  const r = await sql`
    update answer_pages p set latest_test_status = r.status, latest_test_at = now(), latest_test_answer_id = a.id
    from test_answers a join clinic_test_results r on r.test_answer_id = a.id
    where p.clinic_id=${clinicId} and p.status='live' and p.question_index is not null
      and a.test_run_id=${testRunId} and a.question_index = p.question_index and r.clinic_id = p.clinic_id
    returning p.id`;
  return r.length;
}
