"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import * as wf from "@/lib/pages/workflow";
import { clinicFacts } from "@/lib/pages/jobs";
import { renderPageHtml, type PageDraft } from "@/lib/pages/draft";
import { placeholdersIn } from "@/lib/pages/intents";

async function done(id: string, msg?: string) {
  revalidatePath("/portal/pages");
  redirect(`/portal/pages/${id}${msg ? `?msg=${encodeURIComponent(msg)}` : ""}`);
}

async function guard(id: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof wf.WorkflowError) return done(id, e.message);
    throw e;
  }
  return done(id);
}

export async function generateAction(id: string) {
  await requireOwner();
  const [p] = await db()<{ clinic_id: string }[]>`select clinic_id from answer_pages where id=${id}`;
  return guard(id, async () => wf.generateDraft(id, await clinicFacts(p.clinic_id), "owner"));
}
export async function approveAction(id: string) {
  const o = await requireOwner();
  return guard(id, () => wf.ownerApprove(id, o.email));
}
export async function sendAction(id: string) {
  const o = await requireOwner();
  return guard(id, () => wf.sendToClinic(id, o.email));
}
export async function liveAction(id: string, form: FormData) {
  const o = await requireOwner();
  return guard(id, () => wf.markLive(id, String(form.get("url") ?? "").trim(), o.email));
}
export async function rejectAction(id: string) {
  const o = await requireOwner();
  return guard(id, () => wf.reject(id, o.email));
}
export async function editAction(id: string, form: FormData) {
  const o = await requireOwner();
  const [v] = await db()<{ content: PageDraft }[]>`select content from answer_page_versions where page_id=${id} order by version desc limit 1`;
  const d: PageDraft = { ...v.content };
  d.title = String(form.get("title") ?? d.title).trim();
  d.directAnswer = [String(form.get("a1") ?? "").trim(), String(form.get("a2") ?? "").trim()];
  d.details = String(form.get("details") ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
  d.placeholders = placeholdersIn(d.title, d.directAnswer.join(" "), ...d.details, d.contact.address, d.contact.phone, d.contact.hours, JSON.stringify(d.jsonLd));
  d.html = renderPageHtml(d);
  return guard(id, () => wf.ownerEdit(id, d, o.email));
}
