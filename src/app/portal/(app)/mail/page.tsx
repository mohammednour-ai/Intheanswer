import Link from "next/link";
import { db } from "@/lib/db";
import { mailProvider } from "@/lib/mail/provider";
import { channelOpen } from "@/lib/channels/settings";
import { followUpCandidates } from "@/lib/mail/batches";
import { createBatchAction } from "./actions";

export default async function MailPage(props: PageProps<"/portal/mail">) {
  const sp = await props.searchParams;
  const sql = db();
  const batches = await sql`
    select b.*, ci.name as city, (select count(*)::int from mail_pieces p where p.batch_id=b.id) as pieces,
           (select coalesce(sum(cost_cents),0)::int from mail_pieces p where p.batch_id=b.id and p.status not in ('skipped','rejected','held','cancelled','failed')) as cents
    from mail_batches b left join cities ci on ci.id=b.city_id order by b.created_at desc limit 50`;
  const cities = await sql`select id, name from cities order by name`;
  const provider = mailProvider();
  const gate = await channelOpen("letter");
  const due = (await followUpCandidates()).length;
  return (
    <section className="stack">
      <h1>Mail</h1>
      <p className="muted">Nothing is mailed until you approve a batch and press Send. Provider: {provider.name === "fake" ? "none connected (PDFs only)" : provider.live ? "PostGrid, live key" : "PostGrid, test key (nothing is printed)"}. Letter channel: {gate.open ? "open" : gate.reason}.</p>
      {typeof sp.msg === "string" ? <p className="pill pill-warn" role="status" style={{ whiteSpace: "normal" }}>{sp.msg}</p> : null}
      <form action={createBatchAction} className="card stack">
        <h2 style={{ fontSize: "1.1rem" }}>New batch</h2>
        <div className="row">
          <div><label htmlFor="kind">Type</label><select id="kind" name="kind" style={{ width: 240 }}><option value="letter">Letters (first contact)</option><option value="postcard">Follow-up postcards ({due} due)</option></select></div>
          <div><label htmlFor="city">City (letters: one city per batch)</label><select id="city" name="city" style={{ width: 200 }}>{cities.map((c) => <option key={c.id as number} value={c.id as number}>{c.name as string}</option>)}</select></div>
          <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" name="test_mode" defaultChecked style={{ width: 20, height: 20 }} /> Test mode: every piece goes to my own address</label>
        </div>
        <button className="btn btn-primary">Build batch</button>
        <p className="small muted">Building renders each PDF and runs the verification gate. The first real batch is limited to 50 letters.</p>
      </form>
      {batches.length === 0 ? <p className="muted">No batches yet.</p> : (
        <div className="table-scroll"><table>
          <thead><tr><th>Batch</th><th>Type</th><th>City</th><th>Pieces</th><th>Cost (USD)</th><th>Status</th></tr></thead>
          <tbody>{batches.map((b) => (
            <tr key={b.id as string}>
              <td><Link href={`/portal/mail/${b.id}`}>{b.label as string}</Link>{b.test_mode ? " (test)" : ""}</td>
              <td>{b.kind as string}</td><td>{(b.city as string) ?? ""}</td><td>{b.pieces as number}</td><td>{((b.cents as number) / 100).toFixed(2)}</td>
              <td><span className="pill">{b.status as string}</span></td>
            </tr>))}</tbody>
        </table></div>
      )}
    </section>
  );
}
