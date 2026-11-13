import { db } from "../db";
import { addSuppression } from "../sending/suppression";

/**
 * An opt-out from any channel stops ALL mail, email and calls to that clinic:
 * every address is suppressed, unsent letters and messages are cancelled,
 * call requests are cancelled and consents revoked.
 */
export async function optOutClinic(clinicId: string, channel: "mail" | "email" | "call" | "web", source: string, detail?: string): Promise<void> {
  const sql = db();
  const [c] = await sql<{ domain: string | null }[]>`select domain from clinics where id=${clinicId}`;
  if (!c) return;
  await sql`insert into optouts (clinic_id, channel, source, detail) values (${clinicId}, ${channel}, ${source}, ${detail ?? null})`;
  await sql`update clinics set opted_out_at=coalesce(opted_out_at, now()), status='suppressed', status_reason=${`opted out (${channel})`}, updated_at=now()
            where id=${clinicId}`;
  const emails = await sql<{ email: string }[]>`
    select email from contacts where clinic_id=${clinicId} union select email from email_consents where clinic_id=${clinicId}`;
  for (const e of emails) await addSuppression("address", e.email, "clinic opted out", `optout_${channel}`);
  if (c.domain) await addSuppression("domain", c.domain, "clinic opted out", `optout_${channel}`);
  await sql`update messages set status='cancelled', updated_at=now()
            where clinic_id=${clinicId} and status in ('draft','pending_review','held','approved','scheduled')`;
  await sql`update mail_pieces set status='cancelled', status_reason='clinic opted out', updated_at=now()
            where clinic_id=${clinicId} and status in ('draft','held','approved')`;
  await sql`update call_requests set status='cancelled', handled_at=now() where clinic_id=${clinicId} and status='waiting'`;
  await sql`update call_consents set revoked_at=now() where clinic_id=${clinicId} and revoked_at is null`;
  await sql`update email_consents set revoked_at=now() where clinic_id=${clinicId} and revoked_at is null`;
}

export async function isOptedOut(clinicId: string): Promise<boolean> {
  const [c] = await db()<{ o: boolean }[]>`select (opted_out_at is not null or status in ('suppressed','do_not_contact')) as o from clinics where id=${clinicId}`;
  return !!c?.o;
}
