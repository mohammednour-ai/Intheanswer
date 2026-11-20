import { requireOwner } from "@/lib/auth";
import { listMessages, listHeldClinics } from "@/lib/portal/queries";
import { MessageList } from "../MessageList";
import { acceptSelfServeAction, refreshOutdatedAction } from "./actions";
import { db } from "@/lib/db";

export default async function HeldPage() {
  await requireOwner();
  const items = await listMessages(["held", "blocked"]);
  const clinics = await listHeldClinics();
  const [{ n: outdated }] = await db()<{ n: number }[]>`
    select count(*)::int as n from messages
    where status='held' and type in ('first_email', 'self_serve_teaser') and report_id is not null and review_reason like 'not sent:%'`;
  return (
    <section>
      <h1>Held</h1>
      <p className="muted">Items the verification gate or a sending rule stopped, with the reason.</p>
      {outdated > 0 && (
        <form action={refreshOutdatedAction} className="card" style={{ margin: "16px 0" }}>
          <p>
            <strong>{outdated} {outdated === 1 ? "email was" : "emails were"} not sent</strong> because {outdated === 1 ? "it was" : "they were"} written
            before the sender details changed (the send check found the old address or name). Rebuilding writes each one again
            with the current wording, from its already-checked report. Nothing is sent: they come back to the Queue for you to approve.
          </p>
          <button type="submit">Rebuild {outdated} with the current wording</button>
        </form>
      )}
      <MessageList items={items} empty="No held messages." />
      <h2 style={{ marginTop: 32 }}>Held clinics</h2>
      {clinics.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Clinic</th>
                <th>City</th>
                <th>Sector</th>
                <th>Reason</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {clinics.map((c) => (
                <tr key={c.id as string}>
                  <td>{c.name as string}</td>
                  <td>{c.city as string}</td>
                  <td>{c.sector as string}</td>
                  <td>{c.status_reason as string}</td>
                  <td>
                    {c.source === "self_serve" && String(c.status_reason ?? "").startsWith("self-serve:") ? (
                      <form action={acceptSelfServeAction.bind(null, c.id as string)}>
                        <button type="submit">Accept address and run</button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
