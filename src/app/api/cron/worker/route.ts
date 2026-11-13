import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { constantTimeEqual } from "@/lib/tokens";
import { runWorkerBudget } from "@/lib/jobs/worker";
import { scheduleTickSafely } from "@/lib/schedule/tick";
import "@/lib/jobs/register";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Called every minute by Supabase pg_cron (Authorization: Bearer CRON_SECRET).
 * Vercel Cron also calls it once a day as a safety net: the Hobby plan allows
 * no more often. On a paid plan the Vercel schedule can be every minute instead.
 */
export async function GET(req: NextRequest) {
  const secret = env().CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !constantTimeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await scheduleTickSafely(); // starts what is due (only ever enqueues); never throws
  // one job at a time, inside the function's time limit (maxDuration below)
  const res = await runWorkerBudget(270_000);
  return NextResponse.json(res);
}
