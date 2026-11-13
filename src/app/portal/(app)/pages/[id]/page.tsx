import { requireOwner } from "@/lib/auth";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import type { PageDraft } from "@/lib/pages/draft";
import { generateAction, approveAction, sendAction, liveAction, rejectAction, editAction } from "../actions";

export default async function PageDetail(props: PageProps<"/portal/pages/[id]">) {
  await requireOwner();
  const { id } = await props.params;
  const sp = await props.searchParams;
  const sql = db();
  const [p] = await sql`
    select p.*, p.status::text as status, p.latest_test_status::text as latest, coalesce(c.site_name, c.name) as clinic, c.id as clinic_id
    from answer_pages p join clinics c on c.id=p.clinic_id where p.id=${id}`;
  if (!p) notFound();
  const [v] = await sql<{ version: number; content: PageDraft; created_by: string }[]>`
    select version, content, created_by from answer_page_versions where page_id=${id} order by version desc limit 1`;
  const events = await sql`select * from answer_page_events where page_id=${id} order by at desc`;
  const d = v?.content;
  const status = p.status as string;
  const link = p.clinic_token ? `${env().APP_URL}/approve/page/${p.clinic_token}` : null;
  return (
    <article className="stack">
      <p><Link href="/portal/pages">Back to pages</Link> · <Link href={`/portal/clinic/${p.clinic_id}`}>{p.clinic as string}</Link></p>
      <h1 style={{ marginBottom: 0 }}>{p.title as string}</h1>
      <div className="row small"><span className="pill">{status.replaceAll("_", " ")}</span><span className="muted">Target: {p.target_question as string}</span></div>
      {typeof sp.msg === "string" && <p className="pill pill-warn" role="alert">{sp.msg}</p>}
      <p className="small">Why proposed: {p.reason as string}</p>
      <p className="small">Latest test of the target question: <strong>{p.latest ? String(p.latest).replace("_", " ") : "not tested yet"}</strong>{p.live_url ? <> · Live at <a href={p.live_url as string}>{p.live_url as string}</a></> : null}</p>

      {d ? (
        <section className="card stack">
          <h2 style={{ fontSize: "1.1rem" }}>Draft v{v.version} <span className="small muted">by {v.created_by}</span></h2>
          <p><strong>{d.directAnswer.join(" ")}</strong></p>
          <ul>{d.details.map((x, i) => <li key={i}>{x}</li>)}</ul>
          <p className="small">{d.contact.address} · {d.contact.phone} · Hours: {d.contact.hours}{d.contact.hoursSource ? ` (from ${d.contact.hoursSource})` : ""}</p>
          <p className="small"><strong>{d.placeholders.length}</strong> placeholder(s) to confirm.</p>
          <ul className="small muted">{d.reviewerNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          <details><summary style={{ cursor: "pointer" }}>Structured data</summary><pre>{JSON.stringify(d.jsonLd, null, 2)}</pre></details>
        </section>
      ) : <p className="muted">No draft yet.</p>}

      <section className="card stack" aria-label="Actions">
        <div className="row">
          {status === "proposed" && <form action={generateAction.bind(null, id)}><button className="btn btn-primary">Generate draft</button></form>}
          {status === "draft" && <form action={approveAction.bind(null, id)}><button className="btn btn-primary">Approve draft</button></form>}
          {status === "owner_reviewed" && <form action={sendAction.bind(null, id)}><button className="btn btn-primary">Send to clinic for approval</button></form>}
          {status !== "live" && status !== "rejected" && <form action={rejectAction.bind(null, id)}><button className="btn btn-danger">Reject</button></form>}
        </div>
        {link && status === "sent_to_clinic" && <p className="small">Clinic approval link (no account needed): <code>{link}</code></p>}
        {status === "clinic_approved" && (
          <form action={liveAction.bind(null, id)} className="row">
            <div style={{ flex: 1 }}><label htmlFor="url">Published URL</label><input id="url" name="url" type="url" required placeholder="https://" /></div>
            <button className="btn btn-primary">Mark live</button>
          </form>
        )}
        {d && ["draft", "owner_reviewed", "changes_requested", "clinic_approved", "live"].includes(status) && (
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Edit (creates a new version)</summary>
            <form action={editAction.bind(null, id)} className="stack">
              <div><label htmlFor="title">Title (the question)</label><input id="title" name="title" type="text" defaultValue={d.title} /></div>
              <div><label htmlFor="a1">Direct answer, sentence 1</label><input id="a1" name="a1" type="text" defaultValue={d.directAnswer[0]} /></div>
              <div><label htmlFor="a2">Direct answer, sentence 2</label><input id="a2" name="a2" type="text" defaultValue={d.directAnswer[1]} /></div>
              <div><label htmlFor="details">Details (one per line)</label><textarea id="details" name="details" defaultValue={d.details.join("\n")} /></div>
              <button className="btn">Save new version</button>
            </form>
          </details>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: "1.1rem" }}>History</h2>
        <ul className="small">
          {events.map((e) => (
            <li key={String(e.id)}>
              {new Date(e.at as Date).toLocaleString("en-CA", { timeZone: "America/Toronto" })}: {(e.from_status as string) ?? "new"} → {e.to_status as string} by {e.actor as string}
              {e.actor_detail ? ` (${e.actor_detail})` : ""}{e.note ? `: ${e.note}` : ""}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
