"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { approveBatch, buildLetterBatch, buildPostcardBatch, markReturned, rejectBatch, sendBatch, MailError } from "@/lib/mail/batches";
import { db } from "@/lib/db";
import { dial, DialRefused } from "@/lib/calls/consent";

const back = (path: string, msg?: string) => redirect(`${path}${msg ? `?msg=${encodeURIComponent(msg)}` : ""}`);

export async function createBatchAction(form: FormData) {
  await requireOwner();
  const kind = String(form.get("kind"));
  const testMode = form.get("test_mode") === "on";
  let id: string;
  try {
    const r = kind === "postcard" ? await buildPostcardBatch({ testMode }) : await buildLetterBatch({ cityId: Number(form.get("city")), testMode });
    id = r.batchId;
  } catch (e) {
    return back("/portal/mail", (e as Error).message);
  }
  revalidatePath("/portal/mail");
  redirect(`/portal/mail/${id}`);
}

export async function approveAction(batchId: string, form: FormData) {
  const owner = await requireOwner();
  const ids = form.getAll("piece").map(String);
  const all = form.get("intent") === "all";
  try {
    if (!all && ids.length === 0) throw new MailError("select at least one piece, or approve all");
    await approveBatch(batchId, owner.email, all ? undefined : ids);
  } catch (e) {
    return back(`/portal/mail/${batchId}`, (e as Error).message);
  }
  back(`/portal/mail/${batchId}`, "Approved. Nothing is mailed until you press Send.");
}

export async function rejectAction(batchId: string, form: FormData) {
  const owner = await requireOwner();
  try {
    await rejectBatch(batchId, owner.email, String(form.get("reason") ?? ""));
  } catch (e) {
    return back(`/portal/mail/${batchId}`, (e as Error).message);
  }
  back(`/portal/mail/${batchId}`, "Batch rejected.");
}

export async function sendAction(batchId: string) {
  await requireOwner();
  let msg: string;
  try {
    const s = await sendBatch(batchId);
    msg = `${s.submitted} submitted, ${s.skipped.length} skipped${s.stopped ? `; stopped: ${s.stopped}` : ""}.`;
  } catch (e) {
    msg = (e as Error).message;
  }
  back(`/portal/mail/${batchId}`, msg);
}

export async function returnedAction(pieceId: string, batchId: string) {
  await requireOwner();
  await markReturned(pieceId, "returned to sender (recorded by owner)");
  back(`/portal/mail/${batchId}`, "Marked returned. The address is now marked bad.");
}

/** Start a call: the dial function decides. The number is shown only when consent and hours allow. */
export async function startCallAction(requestId: string) {
  await requireOwner();
  try {
    const d = await dial(requestId);
    back("/portal/channels", `Cleared to call ${d.name} at ${d.phone}. Mark the result when done.`);
  } catch (e) {
    if (e instanceof DialRefused) return back("/portal/channels", `Call refused: ${e.message}.`);
    throw e;
  }
}

export async function callResultAction(requestId: string, status: "called" | "no_answer" | "cancelled") {
  await requireOwner();
  await db()`update call_requests set status=${status}, handled_at=now() where id=${requestId} and status='waiting'`;
  revalidatePath("/portal/channels");
}
