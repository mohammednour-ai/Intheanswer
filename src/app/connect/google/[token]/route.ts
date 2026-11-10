import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authUrl } from "@/lib/reviews/gbp";

/** The clinic opens this link to connect its own Google Business Profile (no account with us). */
export async function GET(_req: NextRequest, ctx: RouteContext<"/connect/google/[token]">) {
  const { token } = await ctx.params;
  const [c] = await db()`select 1 from gbp_connections where connect_token=${token} and status in ('pending','error')`;
  if (!c) return new Response("This link is not valid.", { status: 404 });
  return NextResponse.redirect(authUrl(token));
}
