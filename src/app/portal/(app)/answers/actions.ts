"use server";

import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { expandAnswer, unknownPlaceholders } from "@/lib/answers";
import { scanLanguage } from "@/lib/pipeline/verify";

/**
 * Save one approved answer. It is refused, with the reason, when it would
 * break the wording rules every email and call obeys (a superlative, a
 * promised result, pressure) or holds a placeholder that would not be filled
 * in: an answer saved here is said and sent as it stands.
 */
export async function saveAnswerAction(id: number, form: FormData) {
  await requireOwner();
  const answer = String(form.get("answer") ?? "").replace(/\r\n/g, "\n").trim().slice(0, 2000);
  const active = form.get("active") === "on";
  const back = (msg: string, ok = false) => redirect(`/portal/answers?${ok ? "saved" : "error"}=${encodeURIComponent(msg)}#answer-${id}`);
  if (answer.length < 10) back("The answer is too short to be useful. Nothing was changed.");
  const unknown = unknownPlaceholders(answer);
  if (unknown.length) back(`Unknown placeholder ${unknown.join(", ")}. Nothing was changed.`);
  const faults = scanLanguage(expandAnswer(answer), "answer");
  if (faults.length) back(`Not saved: ${faults.map((f) => f.message).join("; ")}.`);
  const rows = await db()`update approved_answers set answer = ${answer}, active = ${active}, updated_at = now() where id = ${id} returning id`;
  back(rows.length ? "Saved. It is used from the next email draft and the next call." : "That answer no longer exists.", rows.length > 0);
}
