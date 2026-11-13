import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getChannel } from "@/lib/channels/settings";
import { optOutClinic } from "@/lib/channels/optout";
import { resolveCode } from "@/lib/qr";
import { unsubscribe } from "@/lib/unsubscribe";

export const metadata: Metadata = {
  title: "Opt out",
  description: "Stop all mail, email and calls from In The Answer. No login needed; it takes effect at once.",
};
export const dynamic = "force-dynamic";

async function optOut(form: FormData) {
  "use server";
  const code = String(form.get("code") ?? "").trim().toLowerCase().replace(/^.*\/r\//, "");
  const email = String(form.get("email") ?? "").trim();
  const hit = code ? await resolveCode(code) : null;
  if (hit) await optOutClinic(hit.clinicId, "web", "optout_page");
  if (email) await unsubscribe(email, "unsubscribe_form");
  // the same answer either way, so the page cannot be used to test codes
  redirect("/optout?done=1");
}

export default async function OptOut(props: PageProps<"/optout">) {
  const sp = await props.searchParams;
  const number = String((await getChannel("inbound")).number ?? "");
  return (
    <section style={{ padding: "48px 0", maxWidth: 560 }}>
      <h1>Opt out</h1>
      {sp.done ? (
        <p role="status">Done. If we had your clinic on our list, it will not receive any more mail, email or calls from In The Answer.</p>
      ) : (
        <form action={optOut} className="stack">
          <p>Enter the code from your letter (the last part of the web address under the QR code), or the email address we wrote to. One opt-out stops all mail, email and calls to your clinic.</p>
          <div>
            <label htmlFor="code">Code from your letter</label>
            <input id="code" name="code" type="text" defaultValue={typeof sp.code === "string" ? sp.code : ""} autoComplete="off" />
          </div>
          <div>
            <label htmlFor="email">Or your email address</label>
            <input id="email" name="email" type="email" autoComplete="email" />
          </div>
          <button className="btn btn-primary">Stop all contact</button>
          <p className="small muted">You can also call {number} and ask to be removed.</p>
        </form>
      )}
    </section>
  );
}
