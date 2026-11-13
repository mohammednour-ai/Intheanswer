import { receiveWebhook } from "@/lib/payments/events";

// Stripe signs the exact bytes it sent, so the body is read as raw text and
// never parsed before the signature is checked. No session or cron secret
// applies here: the signature is the authentication.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const raw = await req.text();
  const r = await receiveWebhook(raw, req.headers.get("stripe-signature"));
  return new Response(r.body, { status: r.status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
