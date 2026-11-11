import { db } from "./db";
import { addSuppression, normalizeEmail } from "./sending/suppression";

/**
 * Unsubscribe: works without login, takes effect at once, never expires.
 * The address is suppressed, every unsent message to it is cancelled, and the
 * clinic it belongs to is closed to further contact.
 */
export async function unsubscribe(emailRaw: string, source: "unsubscribe_link" | "unsubscribe_form" | "one_click"): Promise<void> {
  const email = normalizeEmail(emailRaw);
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(email)) return;
  const sql = db();
  await addSuppression("address", email, "unsubscribed", source);
  await sql`update messages set status='cancelled', updated_at=now()
            where lower(to_email)=${email} and status in ('draft','pending_review','held','approved','scheduled')`;
  await sql`update clinics set status='suppressed', status_reason='unsubscribed', updated_at=now()
            where id in (select clinic_id from contacts where lower(email)=${email})
              and status not in ('customer')`;
}
