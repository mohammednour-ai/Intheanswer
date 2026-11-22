import { type NextRequest } from "next/server";
import { onAnswer } from "@/lib/calls/engine";
import { TOKEN_RE, apology, forbidden, readVoiceWebhook } from "@/lib/calls/webhook";
import { twimlResponse } from "@/lib/calls/twiml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** A call we placed was answered: the opening line. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/voice/answer/[token]">) {
  const { token } = await ctx.params;
  const p = await readVoiceWebhook(req);
  if (!p) return forbidden();
  if (!TOKEN_RE.test(token)) return new Response("Not found", { status: 404 });
  try {
    return twimlResponse(await onAnswer(token));
  } catch (e) {
    return apology(e);
  }
}
