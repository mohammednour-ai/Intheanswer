import { type NextRequest } from "next/server";
import { upgradeWebSocket } from "@vercel/functions";
import { env } from "@/lib/env";
import { voice } from "@/lib/adapters/voice";
import { RelaySession } from "@/lib/calls/relay";
import { verifyRelayKey } from "@/lib/calls/relayConfig";
import { TOKEN_RE } from "@/lib/calls/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The longest a function may run on the Hobby plan. The session hands the call to a new
// connection well before this (RELAY.handoverAfterMs in src/lib/calls/relay.ts).
export const maxDuration = 300;

/**
 * Real-time voice: Twilio ConversationRelay opens this connection for one call. The address
 * carries a key signed with APP_SECRET (relayConfig.ts), handed out only in the TwiML we return
 * to Twilio's signed requests; without it nothing is opened.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/voice/relay/[token]">) {
  const { token } = await ctx.params;
  const key = req.nextUrl.searchParams.get("k");
  if (!TOKEN_RE.test(token) || !verifyRelayKey(token, key)) return new Response("Not found", { status: 404 });

  // Twilio also signs the opening request. How it signs a wss address is not documented, so the
  // result is only logged until it has been seen on real calls; the key above is what admits.
  const signature = req.headers.get("x-twilio-signature");
  const url = `${env().APP_URL.replace(/\/$/, "").replace(/^http/, "ws")}${req.nextUrl.pathname}${req.nextUrl.search}`;
  console.info("relay connection", { signed: !!signature, signatureValid: signature ? voice().validate(url, {}, signature) : null });

  return upgradeWebSocket(async (ws) => {
    const session = new RelaySession(token, (m) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    });
    // the function stays alive while the call is on this connection
    await new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        void session.handle(String(data)).catch((e) => console.error("relay message failed", e));
      });
      ws.on("close", () => {
        session.close();
        resolve();
      });
      ws.on("error", (e) => console.error("relay socket error", e));
    });
  });
}
