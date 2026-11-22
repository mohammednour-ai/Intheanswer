import type { NextRequest } from "next/server";
import { env, ownerDetails } from "../env";
import { voice } from "../adapters/voice";
import { sayAndHangUp, twimlResponse } from "./twiml";

/**
 * Shared by the /api/voice routes: read the provider's form post and refuse
 * anything that is not signed by it. The signature covers the public URL the
 * provider called, so it is rebuilt from APP_URL (behind a proxy the request's
 * own URL can be an internal one).
 */
export async function readVoiceWebhook(req: NextRequest): Promise<Record<string, string> | null> {
  const params = Object.fromEntries(new URLSearchParams(await req.text()));
  const url = `${env().APP_URL.replace(/\/$/, "")}${req.nextUrl.pathname}${req.nextUrl.search}`;
  return voice().validate(url, params, req.headers.get("x-twilio-signature")) ? params : null;
}

export const forbidden = () => new Response("invalid signature", { status: 403 });

export const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Something failed on our side mid-call: the caller hears an apology, never the provider's error tone. */
export function apology(e: unknown): Response {
  console.error("voice webhook failed", e);
  const o = ownerDetails();
  return twimlResponse(sayAndHangUp(`I am sorry, something went wrong on our side. ${o.name} will follow up with you. Goodbye.`));
}

export const emptyTwiml = () => twimlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response/>`);
