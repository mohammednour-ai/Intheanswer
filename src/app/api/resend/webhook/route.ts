import { NextResponse, type NextRequest } from "next/server";
import { mail } from "@/lib/adapters/mail";
import { handleMailEvent } from "@/lib/sending/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resend webhook: delivery, bounce and complaint events, and inbound mail.
 * The signature is checked against the raw body; anything unsigned is refused.
 */
export async function POST(req: NextRequest) {
  const payload = await req.text();
  const eventId = req.headers.get("svix-id");
  let ev;
  try {
    ev = mail().verifyWebhook(payload, req.headers);
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }
  if (!eventId) return NextResponse.json({ error: "missing event id" }, { status: 400 });
  const res = await handleMailEvent(ev, eventId);
  return NextResponse.json(res);
}
