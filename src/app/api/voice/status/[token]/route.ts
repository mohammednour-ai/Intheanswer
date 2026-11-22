import { type NextRequest } from "next/server";
import { onStatus } from "@/lib/calls/engine";
import { TOKEN_RE, emptyTwiml, forbidden, readVoiceWebhook } from "@/lib/calls/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Status of a call we placed: answered, completed, busy, no answer, failed. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/voice/status/[token]">) {
  const { token } = await ctx.params;
  const p = await readVoiceWebhook(req);
  if (!p) return forbidden();
  if (TOKEN_RE.test(token)) {
    await onStatus({ token }, { status: p.CallStatus ?? "", durationSeconds: Number(p.CallDuration) || null }).catch((e) => console.error("voice status failed", e));
  }
  return emptyTwiml();
}
