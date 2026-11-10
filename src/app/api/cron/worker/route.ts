import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { constantTimeEqual } from "@/lib/tokens";
import { runWorkerOnce } from "@/lib/jobs/worker";
import "@/lib/jobs/register";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Called every minute by Vercel Cron or Supabase pg_cron (Authorization: Bearer CRON_SECRET). */
export async function GET(req: NextRequest) {
  const secret = env().CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !constantTimeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const res = await runWorkerOnce({ limit: 8 });
  return NextResponse.json(res);
}
