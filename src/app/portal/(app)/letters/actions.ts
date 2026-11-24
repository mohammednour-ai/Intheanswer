"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { approveLetter, prepareLetters, rejectLetter, sendTestCopy } from "@/lib/letters/letters";

const MAILING_CLASSES = ["ca_post_lettermail", "ca_post_personalized"];

function num(v: FormDataEntryValue | null, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return String(v ?? "").trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

const back = (path: string, kind: "ok" | "error", message: string) => redirect(`${path}?${kind}=${encodeURIComponent(message)}`);

export async function saveLetterSettingsAction(form: FormData) {
  await requireOwner();
  const cls = String(form.get("letter_mailing_class") ?? "");
  await db()`update app_settings set
      letters_enabled = ${form.get("letters_enabled") === "on"},
      letter_after_days = ${Math.round(num(form.get("letter_after_days"), 3, 90, 14))},
      letters_per_day = ${Math.round(num(form.get("letters_per_day"), 0, 100, 10))},
      letter_mailing_class = ${MAILING_CLASSES.includes(cls) ? cls : "ca_post_lettermail"},
      letter_cost_usd = ${num(form.get("letter_cost_usd"), 0, 20, 2.22)},
      letters_monthly_budget_usd = ${num(form.get("letters_monthly_budget_usd"), 0, 10000, 100)},
      updated_at = now() where id`;
  revalidatePath("/portal/letters");
  back("/portal/letters", "ok", "Saved.");
}

/** Real mailing has its own button, so it is never switched on by saving the other settings. */
export async function setLettersLiveAction(on: boolean) {
  await requireOwner();
  await db()`update app_settings set letters_live = ${on}, updated_at = now() where id`;
  revalidatePath("/portal/letters");
}

export async function prepareNowAction() {
  await requireOwner();
  const r = await prepareLetters(new Date());
  revalidatePath("/portal/letters");
  back("/portal/letters", "ok", r.prepared + r.held === 0
    ? "No clinic qualifies right now (or letters are off, or today's number is reached)."
    : `Prepared ${r.prepared} letter(s) for your approval${r.held ? `; ${r.held} held` : ""}.`);
}

export async function approveLetterAction(id: string) {
  await requireOwner();
  const r = await approveLetter(id);
  revalidatePath("/portal/letters");
  if (!r.ok) back(`/portal/letters/${id}`, "error", r.message);
  back(`/portal/letters/${id}`, "ok", "Approved. It is posted within a few minutes.");
}

export async function approveAllAction() {
  await requireOwner();
  const ids = await db()<{ id: string }[]>`select id from letters where status = 'review' and gate_passed order by created_at`;
  let ok = 0;
  const problems: string[] = [];
  for (const { id } of ids) {
    const r = await approveLetter(id);
    if (r.ok) ok++;
    else problems.push(r.message);
  }
  revalidatePath("/portal/letters");
  back("/portal/letters", problems.length ? "error" : "ok", `Approved ${ok} letter(s).${problems.length ? ` Not approved: ${[...new Set(problems)].join(" ")}` : ""}`);
}

export async function rejectLetterAction(id: string, form: FormData) {
  await requireOwner();
  await rejectLetter(id, String(form.get("reason") ?? ""));
  revalidatePath("/portal/letters");
  back(`/portal/letters/${id}`, "ok", "Cancelled. This clinic will not get a letter.");
}

export async function testCopyAction(id: string) {
  await requireOwner();
  const r = await sendTestCopy(id);
  revalidatePath(`/portal/letters/${id}`);
  if (!r.ok) back(`/portal/letters/${id}`, "error", r.message);
  else back(`/portal/letters/${id}`, "ok", r.live
    ? "A copy is being printed and posted to your own address."
    : "A test copy was sent to PostGrid with the test key: nothing is printed. You can see it in PostGrid's dashboard.");
}
