import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { clinicApprove, clinicRequestChanges, WorkflowError } from "@/lib/pages/workflow";
import type { PageDraft } from "@/lib/pages/draft";
import { Shell } from "../../../buy/Shell";
import site from "../../../(site)/site.module.css";
import s from "../../../buy/buy.module.css";

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
    <Shell>
      <div className={s.intro}>
        <h1>Review a new page for {p.clinic_name}</h1>
        <p className={s.for}>This page answers the patient question: &ldquo;{p.target_question}&rdquo;. Please confirm every item in brackets. Nothing is published until you approve.</p>
      </div>
      {sp.done === "approved" && <p className={`${s.notice} ${s.noticeOk}`} role="status">Thank you. Your approval is recorded.</p>}
      {sp.done === "changes" && <p className={`${s.notice} ${s.noticeWarn}`} role="status">Thank you. Your note has been sent.</p>}
      {typeof sp.error === "string" && <p className={`${s.notice} ${s.noticeBad}`} role="alert">{sp.error}</p>}

      <section className={s.panel} aria-labelledby="draft-h">
        <span className={s.label}>The page as drafted</span>
        <h2 id="draft-h" className={s.h2}>{d.title}</h2>
        <p className={s.strong}>{d.directAnswer[0]} {d.directAnswer[1]}</p>
        <ul>{d.details.map((x, i) => <li key={i}>{x}</li>)}</ul>
        <p>{d.contact.address}<br />Phone: {d.contact.phone}<br />Hours: {d.contact.hours}</p>
      </section>
      <section className={`${s.panel} ${s.panelSoft}`} aria-labelledby="before-h">
        <h2 id="before-h" className={s.h2}>Before you approve</h2>
        <ul>{d.reviewerNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      </section>

      {open ? (
        <>
          <form action={approve.bind(null, token)} className={s.panel} aria-labelledby="confirm-h">
            <h2 id="confirm-h" className={s.h2}>Confirm the facts</h2>
            {d.placeholders.map((ph) => (
              <div key={ph} className={site.field}>
                <label htmlFor={ph}>{ph}</label>
                <input id={ph} name={ph} type="text" maxLength={500} />
              </div>
            ))}
            <div className={site.field}>
              <label htmlFor="who">Your name and role</label>
              <input id="who" name="who" type="text" required maxLength={120} />
            </div>
            <button className={`${site.btnPrimary} ${site.go}`}>Approve this page</button>
          </form>
          <form action={changes.bind(null, token)} className={s.panel} aria-labelledby="changes-h">
            <h2 id="changes-h" className={s.h2}>Or ask for changes</h2>
            <div className={site.field}>
              <label htmlFor="note">What should change?</label>
              <textarea id="note" name="note" required maxLength={2000} />
            </div>
            <div className={site.field}>
              <label htmlFor="who2">Your name and role</label>
              <input id="who2" name="who" type="text" required maxLength={120} />
            </div>
            <button className={`${site.btnOutline} ${site.go}`}>Send changes</button>
          </form>
        </>
      ) : (
        <p>This link is no longer open for approval (status: {p.status.replaceAll("_", " ")}).</p>
      )}
    </Shell>
  );
}
