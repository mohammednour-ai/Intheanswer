import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { INTAKE_FIELDS, loadIntake, submitIntake } from "@/lib/payments/intake";
import { Shell } from "../../buy/Shell";

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
        <h1 style={{ marginTop: 24 }}>Thank you</h1>
        <p className="pill pill-ok" role="status">We have your answers for {form.clinicName}.</p>
        <p>We will write to you before anything on your website is changed. To change an answer, reply to our email.</p>
      </Shell>
    );
  }
  return (
    <Shell>
      <h1 style={{ marginTop: 24 }}>Getting started: {form.clinicName}</h1>
      <p className="muted">One short page, so we can begin work on your website. It can be sent once.</p>
      <p className="banner banner-warn" role="note" style={{ borderRadius: 8 }}>
        Never send passwords by this form. We will arrange access to your website another way.
      </p>
      {typeof sp.error === "string" && <p className="pill pill-bad" role="alert">{sp.error.slice(0, 300)}</p>}
      <form action={send.bind(null, token)} className="card stack" style={{ marginTop: 16 }}>
        {INTAKE_FIELDS.map((f) => (
          <div key={f.key}>
            <label htmlFor={f.key}>{f.label}{f.required ? " (needed)" : ""}</label>
            {f.long ? (
              <textarea id={f.key} name={f.key} maxLength={f.max} required={f.required} />
            ) : (
              <input id={f.key} name={f.key} type={f.key === "booking_link" ? "url" : "text"} maxLength={f.max} required={f.required}
                placeholder={f.key === "booking_link" ? "https://" : undefined} autoComplete="off" />
            )}
          </div>
        ))}
        <button className="btn btn-primary">Send</button>
      </form>
    </Shell>
  );
}
