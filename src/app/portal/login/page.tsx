import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { devBypassAllowed } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function sendLink(form: FormData) {
  "use server";
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  // Only the owner address is ever sent a link. The response is the same either way.
  if (email === env().OWNER_EMAIL.toLowerCase()) {
    const sb = await supabaseServer();
    await sb?.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: `${env().APP_URL}/auth/callback` },
    });
  }
  redirect("/portal/login?sent=1");
}

export default async function LoginPage(props: PageProps<"/portal/login">) {
  if (devBypassAllowed()) redirect("/portal");
  const sp = await props.searchParams;
  return (
    <main className="wrap" style={{ maxWidth: 420, paddingTop: 64 }}>
      <h1>Portal sign in</h1>
      {sp.sent ? (
        <p role="status">If that address is allowed, a sign-in link is on its way.</p>
      ) : (
        <form action={sendLink} className="stack">
          <div>
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <button className="btn btn-primary">Email me a sign-in link</button>
        </form>
      )}
    </main>
  );
}
