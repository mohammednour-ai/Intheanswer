import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { batchCost } from "@/lib/mail/batches";
import { approveAction, rejectAction, returnedAction, sendAction } from "../actions";

interface Flag { message: string; severity: string }

export default async function BatchPage(props: PageProps<"/portal/mail/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const sql = db();
  const [b] = await sql`select b.*, ci.name as city from mail_batches b left join cities ci on ci.id=b.city_id where b.id=${id}`;
  if (!b) notFound();
  const pieces = await sql`
    select p.*, coalesce(c.site_name, c.name) as clinic from mail_pieces p join clinics c on c.id=p.clinic_id where p.batch_id=${id} order by p.created_at`;
  const cost = await batchCost(id);
  const draft = b.status === "draft";
  return (
    <section className="stack">
      <p><Link href="/portal/mail">Back to mail</Link></p>
      <h1 style={{ marginBottom: 0 }}>{b.label as string}</h1>
      <div className="row small"><span className="pill">{b.status as string}</span><span className="pill">{b.kind as string}</span>{b.test_mode ? <span className="pill pill-warn">Test mode: goes to your own address</span> : <span className="pill pill-bad">Real mailing</span>}<span className="muted">{(b.city as string) ?? ""}</span></div>
      {typeof sp.msg === "string" ? <p className="pill pill-warn" role="status" style={{ whiteSpace: "normal" }}>{sp.msg}</p> : null}
      <p><strong>Total if all sendable pieces are approved: {cost.usd.toFixed(2)} USD</strong> for {cost.pieces} piece(s).</p>

      <form action={approveAction.bind(null, id)} className="stack">
        <div className="table-scroll"><table>
          <thead><tr><th>{draft ? "Select" : ""}</th><th>Clinic</th><th>Address</th><th>Verification gate</th><th>Preview</th><th>Cost</th><th>Status</th></tr></thead>
          <tbody>{pieces.map((p) => {
            const flags = (p.gate_flags as Flag[]) ?? [];
            const can = draft && p.status === "draft";
            return (
              <tr key={p.id as string}>
                <td>{can ? <input type="checkbox" name="piece" value={p.id as string} aria-label={`Select ${p.clinic}`} style={{ width: 22, height: 22 }} /> : null}</td>
                <td><Link href={`/portal/clinic/${p.clinic_id}`}>{p.clinic as string}</Link><div className="small muted">{p.type as string}{p.headline_variant ? ` · headline ${p.headline_variant}` : ""}</div></td>
                <td className="small">{(p.address_text as string) ?? "none"}<div className="muted">{p.address_status as string}</div></td>
                <td className="small">{p.gate_passed ? <span className="pill pill-ok">Passed</span> : <span className="pill pill-bad">Held</span>}
                  {flags.length ? <ul style={{ margin: "4px 0", paddingLeft: 16 }}>{flags.map((f, i) => <li key={i}>{f.severity === "block" ? "Blocking: " : "Warning: "}{f.message}</li>)}</ul> : null}</td>
                <td>{p.pdf_path ? (
                  <a href={`/portal/mail/piece/${p.id}`} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/portal/mail/piece/${p.id}?thumb=1`} alt={`Preview of the ${p.type} for ${p.clinic}`} width={p.type === "letter" ? 120 : 150} style={{ border: "1px solid var(--line)", display: "block" }} />
                    Open PDF
                  </a>
                ) : "no PDF"}</td>
                <td>{((p.cost_cents as number) / 100).toFixed(2)}</td>
                <td><span className="pill">{String(p.status).replace("_", " ")}</span>{p.status_reason ? <div className="small muted">{p.status_reason as string}</div> : null}</td>
              </tr>);
          })}</tbody>
        </table></div>
        {draft ? (
          <div className="row">
            <button className="btn btn-primary" name="intent" value="all">Approve all sendable ({cost.pieces}, {cost.usd.toFixed(2)} USD)</button>
            <button className="btn" name="intent" value="selected">Approve selected</button>
          </div>
        ) : null}
      </form>

      {draft ? (
        <form action={rejectAction.bind(null, id)} className="card stack">
          <label htmlFor="reason">Reject this batch, with a reason</label>
          <input id="reason" name="reason" type="text" required />
          <button className="btn btn-danger">Reject batch</button>
        </form>
      ) : null}
      {b.status === "approved" || b.status === "sending" ? (
        <form action={sendAction.bind(null, id)} className="card stack">
          <p>Approved by {b.approved_by as string}. {b.test_mode ? "Pressing Send submits these pieces addressed to your own mailing address." : "Pressing Send submits these pieces to be printed and mailed to the clinics."} Each address is verified first; a failed address is skipped and logged.</p>
          <button className="btn btn-primary">Send approved pieces</button>
        </form>
      ) : null}
      {pieces.some((p) => p.mailed_at && p.status !== "returned") ? (
        <div className="card stack">
          <h2 style={{ fontSize: "1.1rem" }}>Mail that came back</h2>
          <p className="small muted">Returned letters come back to your mailing address. Record them here; the address is then marked bad and never mailed again.</p>
          {pieces.filter((p) => p.mailed_at && p.status !== "returned").map((p) => (
            <form key={p.id as string} action={returnedAction.bind(null, p.id as string, id)} className="row"><span>{p.clinic as string}</span><button className="btn">Mark returned</button></form>
          ))}
        </div>
      ) : null}
    </section>
  );
}
