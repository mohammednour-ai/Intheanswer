import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { listReplies } from "@/lib/portal/queries";
import { markHandledAction, sendReplyAction } from "./actions";

const LABEL: Record<string, string> = {
  interested: "Interested",
  question: "Question",
  not_interested: "Not interested",
  unsubscribe: "Unsubscribe",
  auto_reply: "Automatic reply",
  other: "Other",
};

export default async function RepliesPage() {
  await requireOwner();
  const rows = await listReplies();
  return (
    <section>
      <h1>Replies</h1>
      <p className="muted">
        A reply stops further emails to that clinic. Unsubscribe requests are applied at once. Drafted answers wait in the queue for your approval.
      </p>
      {rows.length === 0 ? (
        <p className="muted">No replies yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }} className="stack">
          {rows.map((r) => {
            const id = r.id as string;
            const open = !r.handled;
            return (
              <li key={id} className="card stack">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>
                    {r.clinic_id ? <Link href={`/portal/clinic/${r.clinic_id as string}`}>{(r.clinic_name as string) ?? (r.from_email as string)}</Link> : (r.from_email as string)}
                  </strong>
                  <span>
                    <span className="pill">{LABEL[(r.classification as string) ?? ""] ?? "Being read"}</span>{" "}
                    {r.escalated ? <span className="pill pill-blue">Needs you</span> : null}
                    {r.handled ? <span className="pill">Handled</span> : null}
                  </span>
                </div>
                <div className="small muted">
                  {r.from_email as string} · {new Date(r.received_at as Date).toLocaleString("en-CA", { timeZone: "America/Toronto" })}
                  {r.classification_reason ? ` · ${r.classification_reason as string}` : ""}
                </div>
                <p style={{ margin: 0 }}>
                  <strong>{r.subject as string}</strong>
                </p>
                <pre>{(r.body_text as string)?.slice(0, 2000)}</pre>
                {r.draft_message_id ? (
                  <p className="small">
                    A drafted answer is <Link href={`/portal/item/${r.draft_message_id as string}`}>{String(r.draft_status).replace("_", " ")}</Link>.
                  </p>
                ) : null}
                {open && !r.draft_message_id ? (
                  <details>
                    <summary style={{ cursor: "pointer", fontWeight: 600, minHeight: 44, display: "flex", alignItems: "center" }}>Write a reply</summary>
                    <form action={sendReplyAction.bind(null, id)} className="stack">
                      <label htmlFor={`body-${id}`}>Your reply (your name and address are added underneath)</label>
                      <textarea id={`body-${id}`} name="body" rows={6} required />
                      <button className="btn btn-primary">Send reply</button>
                    </form>
                  </details>
                ) : null}
                {open ? (
                  <form action={markHandledAction.bind(null, id)}>
                    <button className="btn">Mark handled</button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
