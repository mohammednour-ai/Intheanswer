"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { acceptHeldSelfServe } from "@/lib/pipeline/contact";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accept the address typed into the public form and run the report. */
export async function acceptSelfServeAction(clinicId: string) {
  await requireOwner();
  if (!UUID.test(clinicId)) throw new Error("bad clinic id");
  const res = await acceptHeldSelfServe(clinicId);
  if (!res.ok) throw new Error(res.reason ?? "could not run the request");
  revalidatePath("/portal/held");
}
