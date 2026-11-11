"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { submitSelfServe } from "@/lib/selfServe";
import { unsubscribe } from "@/lib/unsubscribe";
import { verifyUnsubscribeToken } from "@/lib/tokens";

export type FormState = { ok: boolean; message: string; values?: { website: string; email: string; sector: string; city: string } } | null;

export async function requestReport(_prev: FormState, form: FormData): Promise<FormState> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "unknown";
  const values = {
    website: String(form.get("website") ?? ""),
    email: String(form.get("email") ?? ""),
    sector: String(form.get("sector") ?? ""),
    city: String(form.get("city") ?? ""),
  };
  const r = await submitSelfServe({ ...values, honeypot: String(form.get("company") ?? ""), ip });
  // on an error, give the entries back so the visitor does not retype them
  return r.ok ? r : { ...r, values };
}

export async function unsubscribeByToken(token: string) {
  const email = verifyUnsubscribeToken(token);
  if (email) await unsubscribe(email, "unsubscribe_link");
  redirect(`/unsubscribe/${token}?done=1`);
}

export async function unsubscribeByEmail(form: FormData) {
  await unsubscribe(String(form.get("email") ?? ""), "unsubscribe_form");
  redirect("/unsubscribe?done=1");
}
