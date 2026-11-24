import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { letterSettings } from "@/lib/letters/letters";
import { letterUrls } from "@/lib/letters/content";
import { LETTER_STATUS } from "../status";
import { approveLetterAction, rejectLetterAction, testCopyAction } from "../actions";

const when = (d: Date | string | null) => (d ? new Date(d).toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" }) : "");

export default async function LetterPage(props: PageProps<"/portal/letters/[id]">) {
  await requireOwner();
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const sp = await props.searchParams;
  const [l] = await db()<{
    id: string; clinic_id: string; code: string; status: string; to_name: string; to_address: string; html: string;
    flags: { code: string; message: string; severity: string }[]; gate_passed: boolean; reject_reason: string | null;
    provider_order_id: string | null; provider_status: string | null; address_status: string | null; address_normalized: string | null;
    live: boolean | null; mailing_class: string | null; cost_usd: string | null; test_orders: { at: string; orderId: string; live: boolean }[];
    last_error: string | null; created_at: Date; approved_at: Date | null; sent_at: Date | null; completed_at: Date | null;
    first_visit_at: Date | null; visit_count: number; stopped_at: Date | null;
  }[]>`select * from letters where id = ${id}`;
  if (!l) notFound();
  const s = letterSettings(await getSettings());
  const st = LETTER_STATUS[l.status] ?? { t: l.status, cls: "" };
  const urls = letterUrls(l.code);
  const ok = typeof sp.ok === "string" ? sp.ok.slice(0, 400) : null;
  const error = typeof sp.error === "string" ? sp.error.slice(0, 600) : null;

  return (
    <article className="stack">
      <p><Link href="/portal/letters">Back to letters</Link></p>
      <header>
        <h1 style={{ marginBottom: 4 }}>{l.to_name}</h1>
        <div className="row small">
          <span className={`pill ${st.cls}`}>{st.t}</span>
          {l.status === "sent" && l.live === false ? <span className="pill pill-warn">test: not printed</span> : null}
          <Link href={`/portal/clinic/${l.clinic_id}`}>Clinic</Link>
          <a href={`/portal/letters/${l.id}/pdf`}>PDF</a>
        </div>
      </header>
      {ok ? <p className="pill pill-ok" role="status">{ok}</p> : null}
      {error ? <p className="pill pill-bad" role="alert">{error}</p> : null}

      <div className="card stack small">
        <div><strong>To:</strong> {l.to_name}, {l.to_address} <span className="muted">(as published on the clinic&apos;s site)</span></div>
        {l.address_normalized ? <div><strong>Canada Post check:</strong> {l.address_status} · {l.address_normalized}</div> : null}
        <div><strong>Printed links:</strong> {urls.typedUrl} (QR code and typed) · {urls.stopUrl}</div>
        <div>
          Prepared {when(l.created_at)}
          {l.approved_at ? ` · approved ${when(l.approved_at)}` : ""}
          {l.sent_at ? ` · posted ${when(l.sent_at)} (${l.mailing_class ?? ""}${l.cost_usd ? `, US$${Number(l.cost_usd).toFixed(2)}` : ""})` : ""}
          {l.provider_status ? ` · PostGrid: ${l.provider_status.replace(/_/g, " ")}` : ""}
          {l.completed_at ? ` · handed to Canada Post ${when(l.completed_at)}` : ""}
        </div>
        {l.status === "sent" ? <div>Opened from the letter: {l.visit_count} time(s){l.first_visit_at ? `, first ${when(l.first_visit_at)}` : ""}.</div> : null}
        {l.stopped_at ? <div><strong>The clinic asked to stop all contact</strong> on the letter&apos;s stop page, {when(l.stopped_at)}.</div> : null}
        {l.reject_reason ? <div><strong>Cancelled:</strong> {l.reject_reason}</div> : null}
        {l.last_error ? <div><strong>Problem:</strong> {l.last_error}</div> : null}
        {l.test_orders.length ? <div>Copies to you: {l.test_orders.map((t) => `${when(t.at)} (${t.live ? "printed" : "test, not printed"})`).join(", ")}</div> : null}
      </div>

      {l.flags.length ? (
        <div className="card stack">
          <strong>{l.gate_passed ? "Notes" : "Why it is held"}</strong>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {l.flags.map((f, i) => <li key={i}>{f.message}</li>)}
          </ul>
        </div>
      ) : null}

      {l.status === "review" ? (
        <div className="row">
          <form action={approveLetterAction.bind(null, l.id)}>
            <button className="btn btn-primary">{s.live ? "Approve and post" : "Approve (test key only while real mailing is off)"}</button>
          </form>
          <form action={testCopyAction.bind(null, l.id)}><button className="btn">Send a copy to me</button></form>
        </div>
      ) : null}
      {["review", "held"].includes(l.status) ? (
        <form action={rejectLetterAction.bind(null, l.id)} className="row" style={{ alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 240px" }}><label htmlFor="reason">Reason (for your records)</label><input id="reason" name="reason" type="text" maxLength={300} /></div>
          <button className="btn btn-danger">Cancel this letter</button>
        </form>
      ) : null}

      <div className="card">
        <iframe
          title={`Letter to ${l.to_name}`}
          srcDoc={l.html}
          sandbox=""
          style={{ width: "100%", aspectRatio: "8.5 / 11", border: 0, display: "block" }}
        />
        <p className="small muted" style={{ margin: 0 }}>The empty box at the top left is where PostGrid prints your return address and the clinic&apos;s address, seen through the envelope window.</p>
      </div>
    </article>
  );
}
