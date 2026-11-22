import crypto from "node:crypto";
import { env } from "../env";

/**
 * Telephony provider (Twilio Programmable Voice). Everything that touches the
 * provider goes through this interface so tests and dry runs never reach the
 * network. Plain REST and a hand-checked signature: no SDK is needed for the
 * two calls we make.
 */
export interface OutboundCall {
  to: string;            // E.164
  from: string;          // our number, E.164
  answerUrl: string;     // TwiML when the call is answered
  statusUrl: string;     // call status events
  amdUrl: string;        // answering-machine detection result (asynchronous, so the greeting is not delayed)
  ringSeconds: number;
  timeLimitSeconds: number;
}

export interface VoiceProvider {
  placeCall(c: OutboundCall): Promise<{ sid: string }>;
  /** Hang up a call in progress (an answering machine picked up). */
  endCall(sid: string): Promise<void>;
  /** True when the request really comes from the provider. */
  validate(url: string, params: Record<string, string>, signature: string | null): boolean;
}

export function voiceConfigured(): boolean {
  const e = env();
  return Boolean(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_PHONE_NUMBER);
}

/**
 * Twilio's request signature: HMAC-SHA1, keyed with the auth token, over the
 * full URL followed by every POST field (name then value) in name order;
 * base64. https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

function twilioProvider(): VoiceProvider {
  const e = env();
  const creds = () => {
    if (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN) throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not set");
    return { sid: e.TWILIO_ACCOUNT_SID, token: e.TWILIO_AUTH_TOKEN };
  };
  const post = async (path: string, form: [string, string][]) => {
    const { sid, token } = creds();
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/${path}`, {
      method: "POST",
      headers: {
        authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
    if (!res.ok) throw new Error(`twilio ${res.status}: ${json.message ?? "request failed"}${json.code ? ` (code ${json.code})` : ""}`);
    return json;
  };
  return {
    async placeCall(c) {
      const r = await post("Calls.json", [
        ["To", c.to],
        ["From", c.from],
        ["Url", c.answerUrl],
        ["Method", "POST"],
        ["StatusCallback", c.statusUrl],
        ["StatusCallbackMethod", "POST"],
        ["StatusCallbackEvent", "answered"],
        ["StatusCallbackEvent", "completed"],
        ["Timeout", String(c.ringSeconds)],
        ["TimeLimit", String(c.timeLimitSeconds)],
        ["MachineDetection", "Enable"],
        ["AsyncAmd", "true"],
        ["AsyncAmdStatusCallback", c.amdUrl],
        ["AsyncAmdStatusCallbackMethod", "POST"],
      ]);
      if (!r.sid) throw new Error("twilio: no call sid returned");
      return { sid: r.sid };
    },
    async endCall(sid) {
      await post(`Calls/${encodeURIComponent(sid)}.json`, [["Status", "completed"]]);
    },
    validate(url, params, signature) {
      if (!signature || !e.TWILIO_AUTH_TOKEN) return false;
      const expected = Buffer.from(twilioSignature(e.TWILIO_AUTH_TOKEN, url, params));
      const got = Buffer.from(signature);
      return expected.length === got.length && crypto.timingSafeEqual(expected, got);
    },
  };
}

const g = globalThis as unknown as { __voice?: VoiceProvider };

export function voice(): VoiceProvider {
  if (!g.__voice) g.__voice = twilioProvider();
  return g.__voice;
}

/** Tests: swap in a fake provider (pass null to restore the real one). */
export function setVoiceProvider(p: VoiceProvider | null) {
  g.__voice = p ?? undefined;
}
