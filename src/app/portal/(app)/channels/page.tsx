import Link from "next/link";
import { channelLists, channelReport, MIN_RESPONSES_PER_ARM, type Funnel, type Comparison } from "@/lib/channels/report";
import { callResultAction, startCallAction } from "../mail/actions";

const usd = (n: number | null) => (n == null ? "n/a" : n.toFixed(2));

function FunnelTable({ title, rows }: { title: string; rows: Funnel[] }) {
  return (
    <section>
      <h2>{title}</h2>
      {rows.length === 0 ? <p className="muted">No contacts yet.</p> : (
        <div className="table-scroll"><table>
          <thead><tr><th>Group</th><th>Contacted</th><th>Delivered (est. for mail)</th><th>Visited</th><th>Call requests</th><th>Asked for email</th><th>Called</th><th>Bought</th><th>Cost USD</th><th>Per visit</th><th>Per call request</th><th>Per sale</th></tr></thead>
          <tbody>{rows.map((f) => (
            <tr key={f.group}><td>{f.group}</td><td>{f.contacted}</td><td>{f.delivered}</td><td>{f.visited}</td><td>{f.callRequests}</td><td>{f.emailAsks}</td><td>{f.called}</td><td>{f.bought}</td>
              <td>{usd(f.costUsd)}</td><td>{usd(f.costPerVisit)}</td><td>{usd(f.costPerCallRequest)}</td><td>{usd(f.costPerSale)}</td></tr>))}</tbody>
        </table></div>
      )}
    </section>
  );
}

function Compare({ title, c }: { title: string; c: Comparison }) {
  return (
    <section className="card">
      <h2 style={{ fontSize: "1.1rem" }}>{title}</h2>
      <p>{c.note}</p>
      <p className="small muted">No arm is shown as ahead until each has {MIN_RESPONSES_PER_ARM} responses.</p>
    </section>
  );
}

export default async function ChannelsReport(props: PageProps<"/portal/channels">) {
  const sp = await props.searchParams;
  const r = await channelReport();
  const l = await channelLists();
  const day = (d: unknown) => new Date(d as Date).toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  return (
    <div className="stack">
      <h1>Channels</h1>
      <p><Link href="/portal/settings/channels">Channel settings and routing rules</Link></p>
      {typeof sp.msg === "string" ? <p className="pill pill-warn" role="status" style={{ whiteSpace: "normal" }}>{sp.msg}</p> : null}

      <section>
        <h2>Call requests waiting ({l.callRequests.length})</h2>
        {l.callRequests.length === 0 ? <p className="muted">None.</p> : (
          <ul style={{ listStyle: "none", padding: 0 }} className="stack">{l.callRequests.map((q) => (
            <li key={q.id as string} className="card">
              <strong>{q.clinic as string}</strong> · {q.contact_name as string}{q.contact_role ? `, ${q.contact_role}` : ""}
              <div className="small">Asked for {day(q.preferred_date)}, {q.window_start as string} to {q.window_end as string} · came from {q.source_channel as string} · consent valid until {day(q.expires_at)}</div>
              <div className="row" style={{ marginTop: 8 }}>
                <form action={startCallAction.bind(null, q.id as string)}><button className="btn btn-primary">Start call</button></form>
                <form action={callResultAction.bind(null, q.id as string, "called")}><button className="btn">Mark called</button></form>
                <form action={callResultAction.bind(null, q.id as string, "no_answer")}><button className="btn">No answer</button></form>
                <form action={callResultAction.bind(null, q.id as string, "cancelled")}><button className="btn">Cancel</button></form>
              </div>
              <div className="small muted">The phone number is shown only when the dial check passes (consent on file, inside calling hours, channel open).</div>
            </li>))}</ul>
        )}
      </section>

      <section>
        <h2>Asked for the full results by email ({l.emailAsks.length})</h2>
        <p className="small muted">Each gave express consent on the results page. Sending arrives with the email phase; until then, send these by hand.</p>
        <ul className="small">{l.emailAsks.map((v) => <li key={v.id as string}>{v.clinic as string}: {v.email as string} · came from {v.source_channel as string} · {day(v.consented_at)}</li>)}</ul>
      </section>

      <FunnelTable title="By channel" rows={r.byChannel} />
      <Compare title="Email versus letter (test split)" c={r.split} />
      <Compare title="Letter headline A versus B" c={r.headline} />
      <FunnelTable title="By mail batch" rows={r.byBatch} />
      <FunnelTable title="By city and channel" rows={r.byCity} />

      <section>
        <h2>Visited, no action ({l.visitedNoAction.length})</h2>
        <p className="small muted">No automatic follow-up is sent to these. You decide.</p>
        <ul className="small">{l.visitedNoAction.map((v) => <li key={v.id as string}><Link href={`/portal/clinic/${v.id}`}>{v.clinic as string}</Link>: {v.visits as number} visit(s), last {day(v.last_visit)}, first came by {v.first_source as string}</li>)}</ul>
      </section>
      <section>
        <h2>Returned mail ({l.returned.length})</h2>
        <ul className="small">{l.returned.map((v) => <li key={v.id as string}>{v.clinic as string}: {v.address_text as string} ({day(v.returned_at)})</li>)}</ul>
      </section>
      <section>
        <h2>Opt-outs ({l.optouts.length})</h2>
        <ul className="small">{l.optouts.map((v) => <li key={String(v.id)}>{(v.clinic as string) ?? "unknown clinic"}: via {v.channel as string} ({v.source as string}), {day(v.created_at)}</li>)}</ul>
      </section>
      <section>
        <h2>Skipped: no address and no email ({l.skipped.length})</h2>
        <ul className="small">{l.skipped.map((v) => <li key={v.clinic_id as string}>{v.clinic as string}: {v.reason as string}</li>)}</ul>
      </section>
    </div>
  );
}
