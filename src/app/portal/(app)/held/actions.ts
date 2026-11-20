"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { acceptHeldSelfServe } from "@/lib/pipeline/contact";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accept the address typed into the public form and run the report. */
export async function acceptSelfServeAction(clinicId: string) {
  await requireOwner();
  if (!UUID.test(clinicId)) throw new Error("bad clinic id");
  const res = await acceptHeldSelfServe(clinicId);
  if (!res.ok) throw new Error(res.reason ?? "could not run the request");
  revalidatePath("/portal/held");
}

/** Teaser emails the send check held because their text predates the current sender details. */
async function outdatedTeaserIds(): Promise<string[]> {
  const rows = await db()<{ id: string }[]>`
    select id from messages
    where status='held' and type in ('first_email', 'self_serve_teaser') and report_id is not null
      and review_reason like 'not sent:%'`;
  return rows.map((r) => r.id);
}

/** Rebuild them with the current wording; each comes back to the Queue for approval. */
export async function refreshOutdatedAction() {
  await requireOwner();
  const ids = await outdatedTeaserIds();
  const stamp = Date.now().toString(36);
  for (const id of ids) await enqueue("refresh_teaser", `refresh:${id}:${stamp}`, { messageId: id }, { priority: 40 });
  revalidatePath("/portal/held");
}
