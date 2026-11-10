import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { clinicApprove, clinicRequestChanges, WorkflowError } from "@/lib/pages/workflow";
import type { PageDraft } from "@/lib/pages/draft";
import { markSvg } from "@/lib/brand";

export const metadata: Metadata = { title: "Review your page", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function load(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [p] = await db()<{ id: string; status: string; title: string; target_question: string; clinic_name: string; content: PageDraft }[]>`
    select p.id, p.status::text, p.title, p.target_question, coalesce(c.site_name, c.name) as clinic_name, v.content
    from answer_pages p join clinics c on c.id=p.clinic_id
    join lateral (select content from answer_page_versions where page_id=p.id order by version desc limit 1) v on true
    where p.clinic_token=${token}`;
  return p ?? null;
}

async function approve(token: string, form: FormData) {
  "use server";
  const values: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k.startsWith("[") && typeof v === "string") values[k] = v.slice(0, 500);
  const who = String(form.get("who") ?? "").slice(0, 120) || "clinic";
  try {
    await clinicApprove(token, values, who);
  } catch (e) {
    if (e instanceof WorkflowError) redirect(`/approve/page/${token}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  redirect(`/approve/page/${token}?done=approved`);
}

async function changes(token: string, form: FormData) {
  "use server";
  await clinicRequestChanges(token, String(form.get("note") ?? ""), String(form.get("who") ?? "clinic"));
  redirect(`/approve/page/${token}?done=changes`);
}

export default async function ApprovePage(props: PageProps<"/approve/page/[token]">) {
  const { token } = await props.params;
  const sp = await props.searchParams;
  const p = await load(token);
  if (!p) notFound();
  const d = p.content;
  const open = p.status === "sent_to_clinic";
  return (
    <main className="wrap" style={{ maxWidth: 760, paddingTop: 32, paddingBottom: 64 }}>
      <div className="row" style={{ gap: 10 }}>
        <span dangerouslySetInnerHTML={{ __html: markSvg({ width: 28 }) }} />
        <strong style={{ fontFamily: "var(--font-head)" }}>In The Answer</strong>
      </div>
      <h1 style={{ marginTop: 24 }}>Review a new page for {p.clinic_name}</h1>
      <p className="muted">This page answers the patient question: &ldquo;{p.target_question}&rdquo;. Please confirm every item in brackets. Nothing is published until you approve.</p>
      {sp.done === "approved" && <p className="pill pill-ok" role="status">Thank you. Your approval is recorded.</p>}
      {sp.done === "changes" && <p className="pill pill-warn" role="status">Thank you. Your note has been sent.</p>}
      {typeof sp.error === "string" && <p className="pill pill-bad" role="alert">{sp.error}</p>}

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: "1.3rem" }}>{d.title}</h2>
        <p><strong>{d.directAnswer[0]} {d.directAnswer[1]}</strong></p>
        <ul>{d.details.map((x, i) => <li key={i}>{x}</li>)}</ul>
        <p>{d.contact.address}<br />Phone: {d.contact.phone}<br />Hours: {d.contact.hours}</p>
      </section>
      <section className="card" style={{ marginTop: 16, background: "var(--soft)" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Before you approve</h2>
        <ul>{d.reviewerNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      </section>

      {open ? (
        <>
          <form action={approve.bind(null, token)} className="card stack" style={{ marginTop: 16 }}>
            <h2 style={{ fontSize: "1.1rem" }}>Confirm the facts</h2>
            {d.placeholders.map((ph) => (
              <div key={ph}>
                <label htmlFor={ph}>{ph}</label>
                <input id={ph} name={ph} type="text" maxLength={500} />
              </div>
            ))}
            <div>
              <label htmlFor="who">Your name and role</label>
              <input id="who" name="who" type="text" required maxLength={120} />
            </div>
            <button className="btn btn-primary">Approve this page</button>
          </form>
          <form action={changes.bind(null, token)} className="card stack" style={{ marginTop: 16 }}>
            <h2 style={{ fontSize: "1.1rem" }}>Or ask for changes</h2>
            <label htmlFor="note">What should change?</label>
            <textarea id="note" name="note" required maxLength={2000} />
            <label htmlFor="who2">Your name and role</label>
            <input id="who2" name="who" type="text" required maxLength={120} />
            <button className="btn">Send changes</button>
          </form>
        </>
      ) : (
        <p className="muted" style={{ marginTop: 16 }}>This link is no longer open for approval (status: {p.status.replaceAll("_", " ")}).</p>
      )}
    </main>
  );
}
