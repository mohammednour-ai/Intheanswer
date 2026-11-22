"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { cancelCall, scheduleOwnerCall } from "@/lib/calls/request";
import { suppressPhone } from "@/lib/calls/rules";
import { normalizeCanadianPhone } from "@/lib/calls/phone";

function num(v: FormDataEntryValue | null, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return String(v ?? "").trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : fallback;
}

export async function setCallsEnabledAction(on: boolean) {
  await requireOwner();
  await db()`update app_settings set calls_enabled=${on}, updated_at=now() where id`;
  revalidatePath("/portal", "layout");
}

export async function saveCallSettingsAction(form: FormData) {
  await requireOwner();
  await db()`update app_settings set calls_daily_cap=${num(form.get("calls_daily_cap"), 0, 200, 20)},
             call_max_minutes=${num(form.get("call_max_minutes"), 3, 30, 10)},
             call_requests_per_report_per_day=${num(form.get("call_requests_per_report_per_day"), 1, 10, 2)}, updated_at=now() where id`;
  revalidatePath("/portal/settings");
}

export async function cancelCallAction(callId: string) {
  await requireOwner();
  await cancelCall(callId);
  revalidatePath("/portal/calls");
}

/** The owner records that a clinic asked to be called, and queues the call. */
export async function scheduleCallAction(clinicId: string, form: FormData) {
  const owner = await requireOwner();
  const r = await scheduleOwnerCall({
    clinicId,
    phone: String(form.get("phone") ?? ""),
    name: String(form.get("name") ?? ""),
    source: String(form.get("source") ?? ""),
    note: String(form.get("note") ?? ""),
    actorEmail: owner.email,
  });
  revalidatePath("/portal/calls");
  redirect(`/portal/clinic/${clinicId}?call=${encodeURIComponent(r.message)}#phone-h`);
}

export async function addCallSuppressionAction(form: FormData) {
  await requireOwner();
  const phone = normalizeCanadianPhone(String(form.get("phone") ?? ""));
  const reason = String(form.get("reason") ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "added by the owner";
  if (phone) await suppressPhone(phone, reason, "owner");
  revalidatePath("/portal/calls");
  redirect(`/portal/calls?dnc=${phone ? "added" : "invalid"}#dnc-h`);
}
