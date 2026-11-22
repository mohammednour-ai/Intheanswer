import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { constantTimeEqual } from "@/lib/tokens";
import { htmlToPdf } from "@/lib/reports/pdf";
import { sampleTeaser } from "@/lib/reports/sample";
import { renderTeaser } from "@/lib/reports/renderTeaser";
import { LIVE_REVIEWS_MARKER } from "@/lib/reviews/liveTable";
import { fillOffer } from "@/lib/reports/offerSection";
import { sampleOfferContext } from "@/lib/reports/offerContext";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Health check for PDF rendering on the deployed host (Bearer CRON_SECRET):
 * renders the sample report to PDF and reports its size and render time.
 * Nothing is stored or sent.
 */
export async function GET(req: NextRequest) {
  const secret = env().CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !constantTimeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();
  try {
    // the same document a clinic is sent: the sample report with its plan cards written in
    const sample = sampleTeaser();
    const pdf = await htmlToPdf(fillOffer(renderTeaser(sample).replace(LIVE_REVIEWS_MARKER, ""), await sampleOfferContext(sample.findingsTotal)));
    const isPdf = pdf.subarray(0, 5).toString("latin1") === "%PDF-";
    return NextResponse.json({ ok: isPdf, bytes: pdf.length, ms: Date.now() - t0 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message).slice(0, 300), ms: Date.now() - t0 }, { status: 500 });
  }
}
