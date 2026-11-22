import { type NextRequest } from "next/server";
import { onRelayEnd } from "@/lib/calls/engine";
import { TOKEN_RE, apology, forbidden, readVoiceWebhook } from "@/lib/calls/webhook";
import { twimlResponse } from "@/lib/calls/twiml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Real-time voice: the live connection for a call has ended (the <Connect action>). We ended it to
 * hang up or to move to a new connection, or it failed; the answer is what the call does next.
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/voice/relay-end/[token]">) {
  const { token } = await ctx.params;
  const p = await readVoiceWebhook(req);
  if (!p) return forbidden();
  if (!TOKEN_RE.test(token)) return new Response("Not found", { status: 404 });
  try {
    return twimlResponse(await onRelayEnd(token, {
      handoff: p.HandoffData, callStatus: p.CallStatus, sessionStatus: p.SessionStatus,
      errorCode: p.ErrorCode, errorMessage: p.ErrorMessage,
    }));
  } catch (e) {
    return apology(e);
  }
}
