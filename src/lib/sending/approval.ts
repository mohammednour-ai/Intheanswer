import { db } from "../db";
import { enqueue } from "../jobs/queue";
import { sha256 } from "../tokens";
import { addSuppression } from "./suppression";
import { scanLanguage } from "../pipeline/verify";
import { sendJobPriority } from "./priority";
import { requeueAudit } from "../jobs/worker";
import { effectiveDryRun } from "../settings";
import { identificationProblems } from "./send";

/**
 * Owner actions on queued messages. Every action is written to approval_log
 * with who did it and when. Approve only moves a message to `approved` and
 * enqueues a send job: the send job re-applies every sending rule (caps,
 * suppression, window, kill switch), so approval never bypasses them.
 */

export interface Actor {
  userId: string;
  email: string;
}

type Msg = {
  id: string;
  status: string;
  subject: string;
  body_text: string;
  flags: unknown[];
  clinic_id: string | null;
  to_email: string;
  type: string;
};

async function load(id: string): Promise<Msg> {
  const [m] = await db()<Msg[]>`select id, status, subject, body_text, flags, clinic_id, to_email, type
                                from messages where id = ${id}`;
  if (!m) throw new Error("message not found");
  return m;
}

async function log(id: string, action: string, actor: Actor, before?: unknown, after?: unknown) {
  const sql = db();
  await sql`insert into approval_log (message_id, action, actor_user_id, actor_email, before, after)
            values (${id}, ${action}, ${actor.userId}, ${actor.email},
                    ${before === undefined ? null : sql.json(before as never)},
                    ${after === undefined ? null : sql.json(after as never)})`;
}

const ACTIONABLE = ["pending_review", "held"];
/** Not yet sent: the owner can still stop these. */
const OPEN = ["draft", "pending_review", "held", "approved", "scheduled"];

export async function approve(id: string, actor: Actor, action: "approve" | "bulk_approve" = "approve") {
  const m = await load(id);
  if (!ACTIONABLE.includes(m.status)) throw new Error(`cannot approve a message in status ${m.status}`);
  if (action === "bulk_approve" && Array.isArray(m.flags) && m.flags.length > 0) {
    throw new Error("bulk approve is only allowed for items with zero flags");
  }
  const sql = db();
  // Approving while live is the owner's go-ahead for a real send; approving in a dry run keeps it a dry-run item.
  const dry = await effectiveDryRun();
  const done = await sql`update messages set status='approved', dry_run=${dry}, expires_at=null, updated_at=now()
                         where id=${id} and status = any(${ACTIONABLE}) returning id`;
  if (!done.length) throw new Error("this item was already handled");
  await log(id, action, actor);
  await enqueue("send_message", `send:${id}`, { messageId: id }, { priority: await sendJobPriority(m.clinic_id) });
}

export async function bulkApprove(ids: string[], actor: Actor) {
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    try {
      await approve(id, actor, "bulk_approve");
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: (e as Error).message });
    }
  }
  return results;
}

export async function editAndApprove(id: string, actor: Actor, subject: string, bodyText: string) {
  const m = await load(id);
  if (!ACTIONABLE.includes(m.status)) throw new Error(`cannot edit a message in status ${m.status}`);
  subject = subject.trim();
  bodyText = bodyText.replace(/\r\n/g, "\n").trim();
  if (!subject || !bodyText) throw new Error("subject and body are required");
  // An edit must still pass the language rules and keep the unsubscribe link.
  const problems = scanLanguage(subject + "\n" + bodyText.split("\n--\n")[0], "edited email").map((f) => f.message);
  // ...and it must still say who is sending it and how to stop it (CASL).
  for (const p of identificationProblems(m.type, bodyText)) problems.push(`edited email: ${p}`);
  if (problems.length) throw new Error(`edit not saved: ${problems.join("; ")}`);
  const sql = db();
  await sql`update messages set subject=${subject}, body_text=${bodyText}, body_html=null,
            content_hash=${sha256(subject + "\n" + bodyText)}, updated_at=now() where id=${id}`;
  await log(id, "edit", actor, { subject: m.subject, body_text: m.body_text }, { subject, body_text: bodyText });
  await approve(id, actor);
}

export async function skip(id: string, actor: Actor) {
  const m = await load(id);
  if (!OPEN.includes(m.status)) throw new Error(`cannot skip a message in status ${m.status}`);
  const sql = db();
  await sql`update messages set status='skipped', updated_at=now() where id=${id} and status = any(${OPEN})`;
  if (m.clinic_id && m.type === "first_email") {
    await sql`update clinics set status='skipped', status_reason='skipped by owner', updated_at=now() where id=${m.clinic_id}`;
  }
  await log(id, "skip", actor);
}

export async function neverContact(id: string, actor: Actor) {
  const m = await load(id);
  const sql = db();
  await addSuppression("address", m.to_email, "owner chose never contact", "owner");
  // a message that already left stays "sent": only unsent ones are cancelled
  await sql`update messages set status='cancelled', updated_at=now() where id=${id} and status = any(${OPEN})`;
  if (m.clinic_id) {
    await sql`update clinics set status='suppressed', status_reason='never contact (owner)', updated_at=now() where id=${m.clinic_id}`;
    await sql`update messages set status='cancelled', updated_at=now()
              where clinic_id=${m.clinic_id} and status in ('pending_review','held','approved','scheduled','draft')`;
  }
  await log(id, "never_contact", actor);
}

/**
 * Regenerate: drop this draft and build a new one from a fresh audit. Only the
 * teaser emails are rebuilt from evidence; for other types the draft is
 * cancelled and the owner writes the reply from the Replies page.
 */
export async function regenerate(id: string, actor: Actor) {
  const m = await load(id);
  if (!ACTIONABLE.includes(m.status)) throw new Error(`cannot regenerate a message in status ${m.status}`);
  const teaser = m.type === "first_email" || m.type === "self_serve_teaser";
  if (teaser && !m.clinic_id) throw new Error("this item has no clinic to rebuild from");
  const sql = db();
  await sql`update messages set status='cancelled', updated_at=now() where id=${id} and status = any(${ACTIONABLE})`;
  await log(id, "regenerate", actor);
  if (teaser && m.clinic_id) {
    const ok = await requeueAudit(m.clinic_id, `g${id.slice(0, 8)}${Date.now().toString(36)}`, "regenerating at the owner's request");
    if (!ok) throw new Error("this clinic can no longer be contacted, so nothing was rebuilt");
  }
}
