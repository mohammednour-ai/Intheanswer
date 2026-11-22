import { type NextRequest } from "next/server";
import { onIncoming } from "@/lib/calls/engine";
import { apology, forbidden, readVoiceWebhook } from "@/lib/calls/webhook";
import { twimlResponse } from "@/lib/calls/twiml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * A clinic phones our number. Set this URL as the number's "A call comes in"
 * webhook in Twilio (POST). The signature is checked; anything unsigned is refused.
 */
export async function POST(req: NextRequest) {
  const p = await readVoiceWebhook(req);
  if (!p) return forbidden();
  if (!p.CallSid) return new Response("missing CallSid", { status: 400 });
  try {
    return twimlResponse(await onIncoming({ callSid: p.CallSid, from: p.From ?? "" }));
  } catch (e) {
    return apology(e);
  }
}
