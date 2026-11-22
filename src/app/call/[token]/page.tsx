import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { COPILOT_NAME, copilotAvatarSvg } from "@/lib/brand";
import { ownerDetails } from "@/lib/env";
import { consentWording, loadCallPage, requestCall } from "@/lib/calls/request";
import { Shell } from "../../buy/Shell";
import site from "../../(site)/site.module.css";
import s from "../../buy/buy.module.css";

export const metadata: Metadata = { title: "Have your report explained by phone", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Reached from a clinic's own report. The clinic asks here to be phoned by the
 * assistant; nothing is dialled without the tick box, and the wording agreed
 * to is stored with the request.
 */
async function ask(token: string, form: FormData) {
  "use server";
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "unknown";
  const r = await requestCall({
    token,
    phone: String(form.get("phone") ?? ""),
    name: String(form.get("name") ?? ""),
    agreed: form.get("agree") === "yes",
    honeypot: String(form.get("ita_check_3c") ?? ""),
    ip,
  });
  redirect(`/call/${token}?${r.ok ? "done" : "error"}=${encodeURIComponent(r.message)}`);
}

export default async function CallPage(props: PageProps<"/call/[token]">) {
  const { token } = await props.params;
  const sp = await props.searchParams;
  const page = await loadCallPage(token);
  if (!page) notFound();
  const o = ownerDetails();
  const done = typeof sp.done === "string" ? sp.done.slice(0, 300) : null;
  const error = typeof sp.error === "string" ? sp.error.slice(0, 300) : null;

  return (
    <Shell>
      <div className={s.intro}>
        <h1>Have your report explained by phone</h1>
        <p className={s.for}>Report for {page.clinicName}</p>
      </div>

      <div className={`${s.panel} ${s.panelSoft}`}>
        <div className={s.assistant}>
          <span dangerouslySetInnerHTML={{ __html: copilotAvatarSvg({ size: 40, label: `${COPILOT_NAME} (AI)` }) }} />
          <div className={s.assistantText}>
            <strong>{COPILOT_NAME} is an AI assistant, not a person.</strong>
            <span>
              It can phone you, walk you through what the report found, and answer questions about the paid options. It only
              states what is in your report. For anything else, a person at In The Answer follows up with you.
            </span>
          </div>
        </div>
      </div>

      {done ? (
        <p className={`${s.notice} ${s.noticeOk}`} role="status">{done}</p>
      ) : !page.open ? (
        <p className={`${s.notice} ${s.noticeWarn}`} role="note">{page.closedReason}</p>
      ) : (
        <form action={ask.bind(null, token)} className={s.panel}>
          {error && <p className={`${s.notice} ${s.noticeBad}`} role="alert">{error}</p>}
          <div className={site.field}>
            <label htmlFor="phone">Phone number to call (Canada)</label>
            <input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" required maxLength={24} placeholder="705-555-0100" />
          </div>
          <div className={site.field}>
            <label htmlFor="name">Who should the assistant ask for? (optional)</label>
            <input id="name" name="name" type="text" autoComplete="name" maxLength={80} />
          </div>
          {/* left empty by people; filled in by bots */}
          <div className={site.hp} aria-hidden="true">
            <label htmlFor="ita_check_3c">Leave this empty</label>
            <input id="ita_check_3c" name="ita_check_3c" type="text" tabIndex={-1} autoComplete="off" />
          </div>
          <label htmlFor="agree" className={site.check}>
            <input id="agree" name="agree" type="checkbox" value="yes" required />
            <span>{consentWording()}</span>
          </label>
          <button className={`${site.btnPrimary} ${site.go}`}>Call me</button>
          <p className={s.fine}>
            We call on business days, {page.hours.replace(/^Monday to Friday, /, "")}. We try twice at most. To stop calls, tell
            the assistant &ldquo;do not call&rdquo; and it will end the call and never ring that number again.
          </p>
        </form>
      )}

      {page.ourNumber && (
        <section className={s.panel}>
          <h2 className={s.h2}>Or phone us when it suits you</h2>
          <p>
            Call <a href={`tel:${page.ourNumber.replace(/-/g, "")}`}><strong>{page.ourNumber}</strong></a>. The same assistant answers. When it asks,
            say or key in your report code: <span className={s.code}>{page.code.slice(0, 3)} {page.code.slice(3)}</span>.
          </p>
        </section>
      )}

      <p className={s.fine}>
        Would you rather speak to a person? Write to <a href={`mailto:${o.email}`}>{o.email}</a> or call {o.phone}.
      </p>
    </Shell>
  );
}
