import { db } from "../db";
import { enqueue } from "../jobs/queue";
import { sha256 } from "../tokens";
import { addSuppression } from "./suppression";
import { scanLanguage } from "../pipeline/verify";

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

export async function approve(id: string, actor: Actor, action: "approve" | "bulk_approve" = "approve") {
  const m = await load(id);
  if (!ACTIONABLE.includes(m.status)) throw new Error(`cannot approve a message in status ${m.status}`);
  if (action === "bulk_approve" && Array.isArray(m.flags) && m.flags.length > 0) {
    throw new Error("bulk approve is only allowed for items with zero flags");
  }
  const sql = db();
  await sql`update messages set status='approved', updated_at=now() where id=${id} and status = any(${ACTIONABLE})`;
  await log(id, action, actor);
  await enqueue("send_message", `send:${id}`, { messageId: id }, { priority: 50 });
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
  if (!/\/unsubscribe\//.test(bodyText)) problems.push("edited email: the unsubscribe link was removed");
  if (problems.length) throw new Error(`edit not saved: ${problems.join("; ")}`);
  const sql = db();
  await sql`update messages set subject=${subject}, body_text=${bodyText}, body_html=null,
            content_hash=${sha256(subject + "\n" + bodyText)}, updated_at=now() where id=${id}`;
  await log(id, "edit", actor, { subject: m.subject, body_text: m.body_text }, { subject, body_text: bodyText });
  await approve(id, actor);
}

export async function skip(id: string, actor: Actor) {
  const m = await load(id);
  const sql = db();
  await sql`update messages set status='skipped', updated_at=now() where id=${id}`;
  if (m.clinic_id && m.type === "first_email") {
    await sql`update clinics set status='skipped', status_reason='skipped by owner', updated_at=now() where id=${m.clinic_id}`;
  }
  await log(id, "skip", actor);
}

export async function neverContact(id: string, actor: Actor) {
  const m = await load(id);
  const sql = db();
  await addSuppression("address", m.to_email, "owner chose never contact", "owner");
  await sql`update messages set status='cancelled', updated_at=now() where id=${id}`;
  if (m.clinic_id) {
    await sql`update clinics set status='suppressed', status_reason='never contact (owner)', updated_at=now() where id=${m.clinic_id}`;
    await sql`update messages set status='cancelled', updated_at=now()
              where clinic_id=${m.clinic_id} and status in ('pending_review','held','approved','scheduled','draft')`;
  }
  await log(id, "never_contact", actor);
}

export async function regenerate(id: string, actor: Actor) {
  const m = await load(id);
  if (!ACTIONABLE.includes(m.status)) throw new Error(`cannot regenerate a message in status ${m.status}`);
  const sql = db();
  await sql`update messages set status='cancelled', updated_at=now() where id=${id}`;
  await log(id, "regenerate", actor);
  await enqueue("regenerate_message", `regen:${id}`, { messageId: id }, { priority: 40 });
}
