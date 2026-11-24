import { type NextRequest } from "next/server";
import { isAutomatedFetch } from "@/lib/site/viewers";
import { LETTER_CODE_RE } from "@/lib/letters/content";
import { letterVisit } from "@/lib/letters/letters";

export const dynamic = "force-dynamic";

/**
 * The short address printed on a letter (intheanswer.ca/l/<code>, also behind its QR code): counts
 * the visit and opens the clinic's report. Only a letter that was posted answers.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/l/[code]">) {
  const code = (await ctx.params).code.toLowerCase();
  if (!LETTER_CODE_RE.test(code)) return new Response("Not found", { status: 404 });
  const counted = !isAutomatedFetch(req.headers.get("user-agent") ?? "", req.headers);
  const v = await letterVisit(code, counted);
  if (!v) return new Response("Not found", { status: 404 });
  return Response.redirect(new URL(`/r/${v.reportToken}`, req.nextUrl.origin), 303);
}
