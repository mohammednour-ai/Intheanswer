import { db } from "../db";
import { env } from "../env";
import { queueOwnerMail } from "../sending/outbox";

/**
 * One owner alert: deduped through owner_notifications (kind, day), mailed
 * with queueOwnerMail, and written as an owner_tasks row (kind 'alert') when
 * it needs action, so it shows in the portal even if mail is down.
 *
 * - `kind` + `day` is the dedupe key: a second alert of the same kind on the
 *   same day is dropped.
 * - `ids`: the things this alert is about (job ids, message ids). They are
 *   remembered in the notification, so `unseenIds` can tell what is new.
 */
export interface Alert {
  kind: string;
  day: string;                 // YYYY-MM-DD (Toronto)
  subject: string;
  body: string;
  ids?: string[];
  detail?: Record<string, unknown>;
  task?: { title: string; body?: string; clinicId?: string | null };
}

export const portalUrl = (path = "") => `${env().APP_URL}/portal${path}`;

export async function raiseAlert(a: Alert): Promise<{ raised: boolean }> {
  const sql = db();
  const raised = await sql.begin(async (tx) => {
    const ins = await tx`
      insert into owner_notifications (kind, day, detail)
      values (${a.kind}, ${a.day}, ${tx.json({ ...(a.detail ?? {}), ids: a.ids ?? [], subject: a.subject } as never)})
      on conflict (kind, day) do nothing returning id`;
    if (!ins.length) return false;
    if (a.task) {
      await tx`insert into owner_tasks (kind, clinic_id, title, body)
               values ('alert', ${a.task.clinicId ?? null}, ${a.task.title}, ${a.task.body ?? a.body})`;
    }
    return true;
  });
  // Idempotent by key: a repeat (or a retry after a failure here) keeps the first mail.
  await queueOwnerMail("owner_alert", `${a.kind}:${a.day}`, a.subject, a.body);
  return { raised };
}

/** Of `ids`, those no earlier alert of this kind has reported. */
export async function unseenIds(kind: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const seen = await db()<{ id: string }[]>`
    select distinct jsonb_array_elements_text(detail->'ids') as id from owner_notifications
    where kind = ${kind} and jsonb_typeof(detail->'ids') = 'array'`;
  const s = new Set(seen.map((r) => r.id));
  return ids.filter((i) => !s.has(i));
}
