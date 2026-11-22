import { env } from "../env";
import type { AppSettings } from "../settings";
import { constantTimeEqual, relayKey } from "../tokens";
import { normalizeCanadianPhone } from "./phone";

/**
 * Which calls use real-time voice, and the addresses Twilio is given for them.
 *
 * Settings > Phone calls > Real-time voice: "off", "listed" (only calls to or from the numbers listed
 * there, to try it), or "all". Every other call keeps the HTTP path (one request per turn).
 */
export function relayWanted(s: Pick<AppSettings, "call_relay" | "call_relay_numbers">, phone: string): boolean {
  if (s.call_relay === "all") return true;
  if (s.call_relay !== "listed") return false;
  const n = normalizeCanadianPhone(phone);
  return !!n && (s.call_relay_numbers ?? []).some((x) => normalizeCanadianPhone(x) === n);
}

/** The numbers real-time voice is tried on, as typed in Settings: any separator, each read as a Canadian number; anything else is dropped. */
export function relayNumbersFrom(raw: string): string[] {
  return [...new Set(raw.split(/[\n,;]+/).map((x) => normalizeCanadianPhone(x.trim())).filter((x): x is string => !!x))].slice(0, 20);
}

const base = () => env().APP_URL.replace(/\/$/, "");

/** The live connection's address. The key in it is signed with APP_SECRET, so only a URL we handed out opens one. */
export function relaySocketUrl(callToken: string): string {
  return `${base().replace(/^http/, "ws")}/api/voice/relay/${callToken}?k=${relayKey(callToken)}`;
}

export function verifyRelayKey(callToken: string, key: string | null): boolean {
  return !!key && constantTimeEqual(key, relayKey(callToken));
}

/** Where Twilio asks what to do when the live connection ends (the <Connect action>). */
export function relayActionUrl(callToken: string): string {
  return `${base()}/api/voice/relay-end/${callToken}`;
}
