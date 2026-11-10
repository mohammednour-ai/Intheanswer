"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import * as approval from "@/lib/sending/approval";
import { db } from "@/lib/db";

async function actor() {
  const o = await requireOwner();
  return { userId: o.userId, email: o.email };
}

export async function approveAction(id: string) {
  await approval.approve(id, await actor());
  revalidatePath("/portal");
  redirect("/portal");
}

export async function editAndSendAction(id: string, form: FormData) {
  await approval.editAndApprove(id, await actor(), String(form.get("subject") ?? ""), String(form.get("body") ?? ""));
  revalidatePath("/portal");
  redirect("/portal");
}

export async function regenerateAction(id: string) {
  await approval.regenerate(id, await actor());
  revalidatePath("/portal");
  redirect("/portal");
}

export async function skipAction(id: string) {
  await approval.skip(id, await actor());
  revalidatePath("/portal");
  redirect("/portal");
}

export async function neverContactAction(id: string) {
  await approval.neverContact(id, await actor());
  revalidatePath("/portal");
  redirect("/portal");
}

export async function bulkApproveAction(ids: string[]) {
  const a = await actor();
  // re-check flags server side: only zero-flag items are accepted
  const rows = await db()<{ id: string }[]>`
    select id from messages where id = any(${ids}) and status='pending_review' and jsonb_array_length(flags) = 0`;
  const res = await approval.bulkApprove(
    rows.map((r) => r.id),
    a,
  );
  revalidatePath("/portal");
  return res;
}
