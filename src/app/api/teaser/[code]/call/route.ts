import { NextResponse, type NextRequest } from "next/server";
import { resolveCode } from "@/lib/qr";
import { createCallRequest } from "@/lib/calls/consent";
import { clientIp, rateLimited } from "@/lib/teaserPage";
import { env } from "@/lib/env";

/** "Request a call" from the teaser page. Consent is required and stored with its evidence. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/teaser/[code]/call">) {
  const { code } = await ctx.params;
  const ip = clientIp(req.headers);
  if (rateLimited("post:" + ip, 8)) return new Response("Too many requests", { status: 429 });
  const hit = await resolveCode(code);
  if (!hit) return new Response("Not found", { status: 404 });
  const f = await req.formData();
  const s = String(f.get("s") ?? "");
  const r = await createCallRequest({
    clinicId: hit.clinicId, name: String(f.get("name") ?? ""), role: String(f.get("role") ?? ""), phone: String(f.get("phone") ?? ""),
    date: String(f.get("date") ?? ""), start: String(f.get("start") ?? ""), end: String(f.get("end") ?? ""),
    consent: f.get("consent") === "yes", ip, pageUrl: `${env().APP_URL}/r/${code}`,
    sourceChannel: s === "q" ? "letter" : s === "e" ? "email" : "typed",
  });
  const to = new URL(`/r/${code}`, req.url);
  if (s) to.searchParams.set("s", s);
  to.searchParams.set(r.ok ? "done" : "err", r.ok ? "call" : r.message);
  to.hash = "next";
  return NextResponse.redirect(to, 303);
}
