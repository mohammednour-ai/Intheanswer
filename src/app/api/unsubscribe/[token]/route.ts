import { type NextRequest } from "next/server";
import { verifyUnsubscribeToken } from "@/lib/tokens";
import { unsubscribe } from "@/lib/unsubscribe";

/** One-click unsubscribe (RFC 8058): mail clients POST here from the List-Unsubscribe header. */
export async function POST(_req: NextRequest, ctx: RouteContext<"/api/unsubscribe/[token]">) {
  const { token } = await ctx.params;
  const email = verifyUnsubscribeToken(token);
  if (!email) return new Response("Invalid link", { status: 400 });
  await unsubscribe(email, "one_click");
  return new Response("Unsubscribed", { status: 200 });
}
