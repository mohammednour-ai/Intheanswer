import { NextResponse, type NextRequest } from "next/server";
import { resolveCode } from "@/lib/qr";
import { createEmailConsent, emailConsentText } from "@/lib/calls/consent";
import { clientIp, rateLimited } from "@/lib/teaserPage";
import { env, ownerDetails } from "@/lib/env";

/** "Email me the full results": express consent, stored with its evidence. Only then may we email them. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/teaser/[code]/email">) {
  const { code } = await ctx.params;
  const ip = clientIp(req.headers);
  if (rateLimited("post:" + ip, 8)) return new Response("Too many requests", { status: 429 });
  const hit = await resolveCode(code);
  if (!hit) return new Response("Not found", { status: 404 });
  const f = await req.formData();
  const s = String(f.get("s") ?? "");
  const o = ownerDetails();
  const r = await createEmailConsent({
    clinicId: hit.clinicId, email: String(f.get("email") ?? ""), consent: f.get("consent") === "yes",
    consentText: emailConsentText(o.name, o.businessName), ip, pageUrl: `${env().APP_URL}/r/${code}`,
    sourceChannel: s === "q" ? "letter" : s === "e" ? "email" : "typed",
  });
  const to = new URL(`/r/${code}`, req.url);
  if (s) to.searchParams.set("s", s);
  to.searchParams.set(r.ok ? "done" : "err", r.ok ? "email" : r.message);
  to.hash = "next";
  return NextResponse.redirect(to, 303);
}
