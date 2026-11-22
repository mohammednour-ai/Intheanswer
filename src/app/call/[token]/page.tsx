import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { COPILOT_NAME, copilotAvatarSvg } from "@/lib/brand";
import { ownerDetails } from "@/lib/env";
import { consentWording, loadCallPage, requestCall } from "@/lib/calls/request";
import { Shell } from "../../buy/Shell";

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
      <h1 style={{ marginTop: 24 }}>Have your report explained by phone</h1>
      <p className="muted">Report for {page.clinicName}</p>

      <div className="card row" style={{ alignItems: "flex-start", gap: 12, marginTop: 16 }}>
        <span dangerouslySetInnerHTML={{ __html: copilotAvatarSvg({ size: 40, label: `${COPILOT_NAME} (AI)` }) }} />
        <div className="stack" style={{ gap: 6, flex: "1 1 260px" }}>
          <strong>{COPILOT_NAME} is an AI assistant, not a person.</strong>
          <span>
            It can phone you, walk you through what the report found, and answer questions about the paid options. It only
            states what is in your report. For anything else, {o.name} follows up with you personally.
          </span>
        </div>
      </div>

      {done ? (
        <p className="pill pill-ok" role="status" style={{ marginTop: 16 }}>{done}</p>
      ) : !page.open ? (
        <p className="banner banner-warn" role="note" style={{ borderRadius: 8, marginTop: 16 }}>{page.closedReason}</p>
      ) : (
        <form action={ask.bind(null, token)} className="card stack" style={{ marginTop: 16 }}>
          {error && <p className="pill pill-bad" role="alert">{error}</p>}
          <div>
            <label htmlFor="phone">Phone number to call (Canada)</label>
            <input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" required maxLength={24} placeholder="705-555-0100" />
          </div>
          <div>
            <label htmlFor="name">Who should the assistant ask for? (optional)</label>
            <input id="name" name="name" type="text" autoComplete="name" maxLength={80} />
          </div>
          {/* left empty by people; filled in by bots */}
          <div style={{ position: "absolute", left: "-9999px" }} aria-hidden="true">
            <label htmlFor="ita_check_3c">Leave this empty</label>
            <input id="ita_check_3c" name="ita_check_3c" type="text" tabIndex={-1} autoComplete="off" />
          </div>
          <label htmlFor="agree" style={{ display: "flex", gap: 10, alignItems: "flex-start", fontWeight: 400 }}>
            <input id="agree" name="agree" type="checkbox" value="yes" required style={{ width: 20, height: 20, marginTop: 2, flex: "0 0 auto" }} />
            <span>{consentWording()}</span>
          </label>
          <button className="btn btn-primary">Call me</button>
          <p className="small muted" style={{ margin: 0 }}>
            We call on business days, {page.hours.replace(/^Monday to Friday, /, "")}. We try twice at most. To stop calls, tell
            the assistant &ldquo;do not call&rdquo; and it will end the call and never ring that number again.
          </p>
        </form>
      )}

      {page.ourNumber && (
        <section className="card stack" style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: "1.1rem", margin: 0 }}>Or phone us when it suits you</h2>
          <p style={{ margin: 0 }}>
            Call <a href={`tel:${page.ourNumber.replace(/-/g, "")}`}><strong>{page.ourNumber}</strong></a>. The same assistant answers. When it asks,
            say or key in your report code: <strong style={{ letterSpacing: "0.08em" }}>{page.code.slice(0, 3)} {page.code.slice(3)}</strong>.
          </p>
        </section>
      )}

      <p className="small muted" style={{ marginTop: 16 }}>
        Would you rather speak to a person? Write to <a href={`mailto:${o.email}`}>{o.email}</a> or call {o.phone}.
      </p>
    </Shell>
  );
}
