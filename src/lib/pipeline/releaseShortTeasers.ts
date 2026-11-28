import { db } from "../db";
import { sha256 } from "../tokens";
import { putFile } from "../storage";
import { MIN_FINDINGS } from "../reports/teaser";
import { prepareTeaserRebuild, renderTeaserPdf } from "./teaserJobs";
import { sectorFitForClinic } from "./sectorFit";
import { queueSend } from "../sending/approval";
import { sendJobPriority } from "../sending/priority";
import { register } from "../jobs/handlers";
import type { JobContext } from "../jobs/queue";

/**
 * Until 28 November 2026 a teaser email was held when fewer than three findings survived
 * verification. Since then two are enough (MIN_FINDINGS). This releases the first emails that
 * were held for that reason alone, with the owner's go-ahead of that day:
 *
 * - only a held first email whose only reason was "only 2 finding(s) survived verification",
 *   to a clinic that is still held, whose report was verified;
 * - rebuilt from the report's verified data with today's wording (no "third finding", the
 *   summary saying "two"), with its PDF; no model call;
 * - checked again: the wording and sender check, and the sector check (it did not exist when
 *   these were held). One that fails stays held, with the new reason;
 * - then approved and given to the send job, which applies every sending rule again
 *   (the daily limit, the window, suppressions), so they go out within the daily limit.
 */

export const HELD_FOR_TWO = "verification gate: only 2 finding(s) survived verification";
const ACTOR = "system: two-finding release (owner approved 2026-11-28)";

export type LeftReason = "moved" | "no_report" | "findings" | "wording" | "sector" | "pdf_failed";

export interface ReleaseOptions {
  dry: boolean;
  limit?: number;
  pdf?: (html: string) => Promise<Buffer>;
  put?: (key: string, data: Buffer, contentType: string) => Promise<string>;
}

export interface ReleaseResult {
  dry: boolean;
  total: number;
  released: string[];
  left: Partial<Record<LeftReason, { id: string; why: string }[]>>;
}

export async function releaseShortTeasers(o: ReleaseOptions): Promise<ReleaseResult> {
  const sql = db();
  const out: ReleaseResult = { dry: o.dry, total: 0, released: [], left: {} };
  const leave = (why: LeftReason, id: string, detail: string) => { (out.left[why] ??= []).push({ id, why: detail }); };
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    select m.id, m.clinic_id from messages m join clinics c on c.id = m.clinic_id
    where m.type = 'first_email' and m.status = 'held' and not m.dry_run and m.review_reason = ${HELD_FOR_TWO}
      and c.status = 'held'
    order by m.created_at`;
  out.total = rows.length;

  for (const row of rows) {
    if (o.limit != null && out.released.length >= o.limit) break;
    const r = await prepareTeaserRebuild(row.id, ["held"]);
    if ("skipped" in r) { leave(r.skipped.startsWith("message is") ? "moved" : "no_report", row.id, r.skipped); continue; }
    if (r.data.findings.length < MIN_FINDINGS) { leave("findings", row.id, `${r.data.findings.length} finding(s)`); continue; }
    const fit = await sectorFitForClinic(row.clinic_id);
    const reasons = r.flags.filter((f) => f.severity === "block").map((f) => f.message);
    if (fit && !fit.ok) reasons.push(`category check: ${fit.reason}`);
    if (reasons.length) {
      const why = (fit && !fit.ok) ? "sector" : "wording";
      leave(why, row.id, reasons.join("; "));
      if (!o.dry) {
        const reason = "verification gate: " + reasons.join("; ");
        await sql`update messages set review_reason=${reason}, updated_at=now() where id=${row.id} and status='held'`;
        await sql`update clinics set status_reason=${reason}, updated_at=now() where id=${row.clinic_id} and status='held'`;
      }
      continue;
    }
    if (o.dry) { out.released.push(row.id); continue; }

    let pdf: Buffer;
    try {
      pdf = await renderTeaserPdf(r, o.pdf);
    } catch (e) {
      leave("pdf_failed", row.id, (e as Error).message);
      continue;
    }
    const { msg, rep, data, draft, html, flags } = r;
    const written = await sql.begin(async (tx) => {
      const [cur] = await tx<{ status: string; review_reason: string | null }[]>`
        select status::text, review_reason from messages where id=${msg.id} for update`;
      if (!cur || cur.status !== "held" || cur.review_reason !== HELD_FOR_TWO) return false;
      const pdfRef = await (o.put ?? putFile)(`reports/${rep.token}.pdf`, pdf, "application/pdf");
      await tx`update reports set data=${tx.json({ ...rep.data, owner: data.owner, summary: data.summary, claims: data.claims } as never)},
                html=${html}, pdf_path=${pdfRef}, pdf_bytes=${pdf.length} where id=${msg.report_id}`;
      await tx`update messages set status='approved', subject=${draft.subject}, body_text=${draft.bodyText}, body_html=null,
                claims=${tx.json([...data.claims, ...draft.claims] as never)}, flags=${tx.json(flags as never)},
                gate_passed=true, requires_review=false, review_reason=null, expires_at=null,
                content_hash=${sha256(draft.subject + "\n" + draft.bodyText)}, updated_at=now()
                where id=${msg.id}`;
      await tx`insert into approval_log (message_id, action, actor_email, before, after)
               values (${msg.id}, 'approve', ${ACTOR},
                       ${tx.json({ subject: msg.subject, body_text: msg.body_text } as never)},
                       ${tx.json({ subject: draft.subject, body_text: draft.bodyText } as never)})`;
      await tx`update clinics set status='queued', status_reason=null, updated_at=now() where id=${row.clinic_id} and status='held'`;
      return true;
    });
    if (!written) { leave("moved", row.id, "changed while this ran"); continue; }
    await queueSend(msg.id, await sendJobPriority(row.clinic_id));
    out.released.push(msg.id);
  }
  return out;
}

/**
 * The release as a job, so it runs in production with production's addresses, signing secret
 * and PDF storage. Started once by hand (kind `release_short_teasers`); each run releases
 * BATCH and queues the next run until none is left.
 */
const BATCH = 10;
register("release_short_teasers", async (ctx: JobContext) => {
  const r = await releaseShortTeasers({ dry: false, limit: BATCH });
  const round = Number((ctx.job.payload as { round?: number }).round ?? 1);
  if (r.released.length === BATCH) await ctx.enqueue("release_short_teasers", `release_short_teasers:${round + 1}`, { round: round + 1 }, { priority: 60 });
  return { released: r.released.length, left: Object.fromEntries(Object.entries(r.left).map(([k, v]) => [k, v.length])), lines: releaseReport(r) };
});

export function releaseReport(r: ReleaseResult): string[] {
  const lines = [
    `Held first emails whose only reason was two findings: ${r.total}`,
    `  ${r.dry ? "would be released" : "released to the send queue"}: ${r.released.length}`,
  ];
  for (const [why, items] of Object.entries(r.left)) {
    lines.push(`  left held (${why}): ${items.length}`);
    for (const it of items.slice(0, 15)) lines.push(`    ${it.id}  ${it.why.slice(0, 160)}`);
  }
  return lines;
}
