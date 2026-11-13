import { db } from "../db";
import { enqueue } from "../jobs/queue";
import type { MailEvent } from "../adapters/mail";
import { addressOf } from "../adapters/mail";
import { unsubscribe } from "../unsubscribe";
import { addSuppression } from "./suppression";
import { evaluateAutoPause } from "./rules";
import { queueOwnerMail } from "./outbox";
import { env } from "../env";
import { localDate } from "../time";

/**
 * Provider events (Resend webhook): delivery, bounce, complaint, inbound mail.
 * Each event is stored once (provider_event_id is unique), so a webhook retry
 * is a no-op. A hard bounce or a complaint suppresses the address at once and
 * the bounce/complaint monitor may pause all sending.
 */
export async function handleMailEvent(ev: MailEvent, eventId: string): Promise<{ handled: boolean; note?: string }> {
  const sql = db();

  if (ev.type === "email.received") {
    if (!ev.emailId) return { handled: false, note: "no email id" };
    await enqueue("ingest_reply", `inbound:${ev.emailId}`, { emailId: ev.emailId }, { priority: 20 });
    return { handled: true, note: "queued for reading" };
  }

  const [msg] = ev.emailId
    ? await sql<{ id: string; to_email: string; clinic_id: string | null; type: string }[]>`
        select id, to_email, clinic_id, type::text from messages where provider_message_id = ${ev.emailId}`
    : [];
  const kind = ev.type.replace(/^email\./, "");
  const stored = await sql`
    insert into message_events (message_id, provider_event_id, type, occurred_at, payload)
    values (${msg?.id ?? null}, ${eventId}, ${kind}, ${ev.createdAt}, ${sql.json(ev.raw as never)})
    on conflict (provider_event_id) do nothing returning id`;
  if (!stored.length) return { handled: true, note: "duplicate" };
  if (!msg) return { handled: true, note: "no matching message" };

  const to = addressOf(ev.to[0] ?? msg.to_email);
  switch (kind) {
    case "delivered":
      await sql`update messages set delivered_at = coalesce(delivered_at, ${ev.createdAt}) where id = ${msg.id}`;
      break;
    case "opened":
      await sql`update messages set opened_at = coalesce(opened_at, ${ev.createdAt}) where id = ${msg.id}`;
      break;
    case "bounced": {
      await sql`update messages set bounced_at = coalesce(bounced_at, ${ev.createdAt}), last_error = ${ev.detail ?? "bounced"} where id = ${msg.id}`;
      // a permanent bounce means the address is dead: never write to it again
      if (!ev.bounceType || /permanent/i.test(ev.bounceType)) {
        await addSuppression("address", to, `bounced: ${ev.detail ?? "permanent"}`, "bounce");
        if (msg.clinic_id) {
          await sql`update clinics set status='no_contact', status_reason=${`the address ${to} bounced`}, updated_at=now()
                    where id=${msg.clinic_id} and status in ('contacted', 'queued')`;
          await sql`update messages set status='cancelled', updated_at=now()
                    where clinic_id=${msg.clinic_id} and status in ('draft','pending_review','held','approved','scheduled')`;
        }
      }
      await monitor();
      break;
    }
    case "complained":
      await sql`update messages set complained_at = coalesce(complained_at, ${ev.createdAt}) where id = ${msg.id}`;
      await unsubscribe(to, "complaint");
      await monitor();
      break;
    case "failed":
    case "suppressed":
      await sql`update messages set last_error = ${ev.detail ?? kind} where id = ${msg.id}`;
      if (kind === "suppressed") await addSuppression("address", to, "suppressed by the email provider", "bounce");
      break;
    default:
      break;
  }
  return { handled: true };
}

/** Run the bounce/complaint monitor and tell the owner when it pauses sending. */
async function monitor() {
  const r = await evaluateAutoPause();
  if (r.paused && r.reason) {
    await queueOwnerMail(
      "owner_alert",
      `autopause:${localDate(new Date())}`,
      "Sending paused automatically",
      [`All outreach is paused: ${r.reason}.`, ``, `Nothing more goes out until you clear the pause in the portal:`, `${env().APP_URL}/portal/settings`].join("\n"),
    );
  }
}
