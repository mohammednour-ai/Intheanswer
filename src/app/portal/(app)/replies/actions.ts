"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { markReplyHandled, replyFromOwner } from "@/lib/replies/ingest";

export async function sendReplyAction(inboundId: string, form: FormData) {
  await requireOwner();
  await replyFromOwner(inboundId, String(form.get("body") ?? ""));
  revalidatePath("/portal/replies");
}

export async function markHandledAction(inboundId: string) {
  await requireOwner();
  await markReplyHandled(inboundId);
  revalidatePath("/portal/replies");
}
