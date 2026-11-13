"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { retryDeadJob, dismissAlertTask } from "@/lib/schedule/status";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function retryJobAction(id: string) {
  await requireOwner();
  if (!UUID.test(id)) throw new Error("bad job id");
  await retryDeadJob(id);
  revalidatePath("/portal/system");
}

export async function dismissAlertAction(id: string) {
  await requireOwner();
  if (!UUID.test(id)) throw new Error("bad task id");
  await dismissAlertTask(id);
  revalidatePath("/portal/system");
}
