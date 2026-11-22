import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { INTAKE_FIELDS, loadIntake, submitIntake } from "@/lib/payments/intake";
import { Shell } from "../../buy/Shell";
import site from "../../(site)/site.module.css";
import s from "../../buy/buy.module.css";

export const metadata: Metadata = { title: "Website intake form", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function send(token: string, form: FormData) {
  "use server";
  const raw: Record<string, unknown> = {};
  for (const f of INTAKE_FIELDS) raw[f.key] = form.get(f.key);
  const r = await submitIntake(token, raw);
  if (r.ok) redirect(`/intake/${token}?done=1`);
  if (r.error === "not_found") notFound();
  redirect(`/intake/${token}?error=${encodeURIComponent(r.message)}`);
}

export default async function IntakePage(props: PageProps<"/intake/[token]">) {
  const { token } = await props.params;
  const sp = await props.searchParams;
  const form = await loadIntake(token);
  if (!form) notFound();
  if (form.submitted) {
    return (
      <Shell>
        <h1>Thank you</h1>
        <p className={`${s.notice} ${s.noticeOk}`} role="status">We have your answers for {form.clinicName}.</p>
        <p>We will write to you before anything on your website is changed. To change an answer, reply to our email.</p>
      </Shell>
    );
  }
  return (
    <Shell>
      <div className={s.intro}>
        <h1>Getting started: {form.clinicName}</h1>
        <p className={s.for}>One short page, so we can begin work on your website. It can be sent once.</p>
      </div>
      <p className={`${s.notice} ${s.noticeWarn}`} role="note">
        Never send passwords by this form. We will arrange access to your website another way.
      </p>
      {typeof sp.error === "string" && <p className={`${s.notice} ${s.noticeBad}`} role="alert">{sp.error.slice(0, 300)}</p>}
      <form action={send.bind(null, token)} className={s.panel}>
        {INTAKE_FIELDS.map((f) => (
          <div key={f.key} className={site.field}>
            <label htmlFor={f.key}>{f.label}{f.required ? " (needed)" : ""}</label>
            {f.long ? (
              <textarea id={f.key} name={f.key} maxLength={f.max} required={f.required} />
            ) : (
              <input id={f.key} name={f.key} type={f.key === "booking_link" ? "url" : "text"} maxLength={f.max} required={f.required}
                placeholder={f.key === "booking_link" ? "https://" : undefined} autoComplete="off" />
            )}
          </div>
        ))}
        <button className={`${site.btnPrimary} ${site.go}`}>Send</button>
      </form>
    </Shell>
  );
}
