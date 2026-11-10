import { listReplies } from "@/lib/portal/queries";

export default async function RepliesPage() {
  const rows = await listReplies();
  return (
    <section>
      <h1>Replies</h1>
      {rows.length === 0 ? (
        <p className="muted">No replies yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }} className="stack">
          {rows.map((r) => (
            <li key={r.id as string} className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{(r.clinic_name as string) ?? (r.from_email as string)}</strong>
                <span className="pill">{(r.classification as string) ?? "unclassified"}</span>
              </div>
              <div className="small muted">
                {r.from_email as string} ·{" "}
                {new Date(r.received_at as Date).toLocaleString("en-CA", { timeZone: "America/Toronto" })}
              </div>
              <p style={{ marginTop: 8 }}>
                <strong>{r.subject as string}</strong>
              </p>
              <pre>{(r.body_text as string)?.slice(0, 1200)}</pre>
              {r.drafted_reply ? (
                <>
                  <div className="small muted">Drafted reply{r.escalated ? " (escalated to you)" : ""}</div>
                  <pre>{r.drafted_reply as string}</pre>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
