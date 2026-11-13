"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";

export async function markTaskDoneAction(id: string) {
  await requireOwner();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  await db()`update owner_tasks set status = 'done', done_at = now() where id = ${id} and status = 'open'`;
  revalidatePath("/portal/customers");
}
