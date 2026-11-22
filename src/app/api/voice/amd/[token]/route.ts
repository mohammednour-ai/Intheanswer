import { type NextRequest } from "next/server";
import { onAmd } from "@/lib/calls/engine";
import { TOKEN_RE, emptyTwiml, forbidden, readVoiceWebhook } from "@/lib/calls/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Answering-machine detection for a call we placed: a machine is hung up on, with no message left. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/voice/amd/[token]">) {
  const { token } = await ctx.params;
  const p = await readVoiceWebhook(req);
  if (!p) return forbidden();
  if (TOKEN_RE.test(token)) await onAmd(token, p.AnsweredBy ?? "").catch((e) => console.error("voice amd failed", e));
  return emptyTwiml();
}
