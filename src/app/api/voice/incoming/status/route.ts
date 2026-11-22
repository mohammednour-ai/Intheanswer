import { type NextRequest } from "next/server";
import { onStatus } from "@/lib/calls/engine";
import { emptyTwiml, forbidden, readVoiceWebhook } from "@/lib/calls/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * End of a call made to our number. Set this URL as the number's "Call status
 * changes" webhook in Twilio (POST). Optional: without it a finished inbound
 * call is closed by the hourly housekeeping instead.
 */
export async function POST(req: NextRequest) {
  const p = await readVoiceWebhook(req);
  if (!p) return forbidden();
  if (p.CallSid) {
    await onStatus({ sid: p.CallSid }, { status: p.CallStatus ?? "", durationSeconds: Number(p.CallDuration) || null }).catch((e) => console.error("voice status failed", e));
  }
  return emptyTwiml();
}
