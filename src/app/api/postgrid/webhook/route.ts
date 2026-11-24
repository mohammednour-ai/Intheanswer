import { env } from "@/lib/env";
import { decodeWebhook } from "@/lib/letters/provider";
import { applyMailEvent } from "@/lib/letters/letters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PostGrid's status updates for letters (set up in PostGrid: a webhook to
 * https://intheanswer.ca/api/postgrid/webhook for letter events, its secret in POSTGRID_WEBHOOK_SECRET).
 * The body is a JWT signed with that secret; anything else is refused.
 */
export async function POST(req: Request) {
  const secret = env().POSTGRID_WEBHOOK_SECRET;
  if (!secret) return new Response("not configured", { status: 503 });
  const raw = (await req.text()).slice(0, 100_000).trim();
  // the JWT is the body itself, or a JSON string holding it
  let jwt = raw;
  try {
    if (raw.startsWith('"')) jwt = String(JSON.parse(raw));
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const ev = decodeWebhook(jwt, secret);
  if (!ev) return new Response("bad signature", { status: 401 });
  if (ev.type.startsWith("letter.") && ev.data.status) await applyMailEvent(ev.data.id, ev.data.status);
  return new Response("ok");
}
