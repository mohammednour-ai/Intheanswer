import Link from "next/link";
import { db } from "@/lib/db";
import { typeLabel } from "../MessageList";

export default async function SentPage() {
  const rows = await db()`
    select m.id, m.type, m.subject, m.to_email, m.sent_at, m.delivered_at, m.opened_at, m.replied_at,
           m.bounced_at, m.complained_at, m.dry_run, c.name as clinic_name
    from messages m left join clinics c on c.id = m.clinic_id
    where m.status = 'sent' order by m.sent_at desc limit 200`;
  return (
    <section>
      <h1>Sent</h1>
      {rows.length === 0 ? (
        <p className="muted">Nothing sent yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Clinic</th>
                <th>Type</th>
                <th>Sent</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const status = r.complained_at
                  ? "complaint"
                  : r.bounced_at
                    ? "bounced"
                    : r.replied_at
                      ? "replied"
                      : r.opened_at
                        ? "opened"
                        : r.delivered_at
                          ? "delivered"
                          : "sent";
                return (
                  <tr key={r.id as string}>
                    <td>
                      <Link href={`/portal/item/${r.id}`}>{(r.clinic_name as string) ?? (r.to_email as string)}</Link>
                    </td>
                    <td>{typeLabel(r.type as string)}</td>
                    <td className="small">
                      {new Date(r.sent_at as Date).toLocaleString("en-CA", { timeZone: "America/Toronto" })}
                      {r.dry_run ? " (dry run)" : ""}
                    </td>
                    <td>
                      <span className="pill">{status}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
