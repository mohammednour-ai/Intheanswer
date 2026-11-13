import { type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { decodeWebhook } from "@/lib/mail/provider";
import { applyProviderEvent } from "@/lib/mail/batches";

/** PostGrid webhook: the body is a JWT signed with the webhook secret (HS256). */
export async function POST(req: NextRequest) {
  const secret = env().POSTGRID_WEBHOOK_SECRET;
  if (!secret) return new Response("not configured", { status: 503 });
  const evt = decodeWebhook(await req.text(), secret);
  if (!evt) return new Response("invalid signature", { status: 401 });
  if (/^(letter|postcard)\.(created|updated)$/.test(evt.type)) await applyProviderEvent(evt);
  return new Response("ok");
}
