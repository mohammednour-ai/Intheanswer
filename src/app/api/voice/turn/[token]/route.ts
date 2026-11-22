import { type NextRequest } from "next/server";
import { onTurn } from "@/lib/calls/engine";
import { TOKEN_RE, apology, forbidden, readVoiceWebhook } from "@/lib/calls/webhook";
import { twimlResponse } from "@/lib/calls/twiml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One model call per turn, cut off at 10 seconds; the provider itself waits about 15.
export const maxDuration = 30;

/** What the person just said (speech or keypad); the answer is the next line. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/voice/turn/[token]">) {
  const { token } = await ctx.params;
  const p = await readVoiceWebhook(req);
  if (!p) return forbidden();
  if (!TOKEN_RE.test(token)) return new Response("Not found", { status: 404 });
  try {
    return twimlResponse(await onTurn(token, { speech: p.SpeechResult, digits: p.Digits }));
  } catch (e) {
    return apology(e);
  }
}
