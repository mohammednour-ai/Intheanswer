"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { submitSelfServe } from "@/lib/selfServe";
import { unsubscribe, unsubscribeByAddress } from "@/lib/unsubscribe";
import { verifyUnsubscribeToken } from "@/lib/tokens";

export type FormState = { ok: boolean; message: string; values?: { website: string; email: string; sector: string; city: string } } | null;

/** The visitor's address as the platform reports it (used only as a keyed hash, for rate limits). */
async function visitorIp(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "unknown";
}

export async function requestReport(_prev: FormState, form: FormData): Promise<FormState> {
  const ip = await visitorIp();
  const values = {
    website: String(form.get("website") ?? ""),
    email: String(form.get("email") ?? ""),
    sector: String(form.get("sector") ?? ""),
    city: String(form.get("city") ?? ""),
  };
  const r = await submitSelfServe({ ...values, honeypot: String(form.get("ita_check_7q") ?? ""), ip });
  // on an error, give the entries back so the visitor does not retype them
  return r.ok ? r : { ...r, values };
}

export async function unsubscribeByToken(token: string) {
  const email = verifyUnsubscribeToken(token);
  if (email) await unsubscribe(email, "unsubscribe_link");
  redirect(`/unsubscribe/${token}?done=1`);
}

/**
 * Unsubscribe by typed address. No proof of ownership is possible here, so it
 * only acts on addresses we actually write to and is rate-limited per visitor
 * (see unsubscribeByAddress). The confirmation is the same in every case.
 */
export async function unsubscribeByEmail(form: FormData) {
  try {
    await unsubscribeByAddress(String(form.get("email") ?? ""), await visitorIp());
  } catch (e) {
    console.error("unsubscribe by address failed", e);
  }
  redirect("/unsubscribe?done=1");
}
