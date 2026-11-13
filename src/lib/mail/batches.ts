import { db } from "../db";
import { ownerDetails, OWNER_PLACEHOLDER_RE } from "../env";
import { htmlToPdfAndThumb } from "../reports/pdf";
import { putFile, getFile } from "../storage";
import { audit, channelOpen, getChannel, type LetterValues } from "../channels/settings";
import { isOptedOut } from "../channels/optout";
import { assign, loadFacts } from "../channels/routing";
import { buildLetterData, gateLetter, renderLetter, type LetterData } from "./letter";
import { mailProvider } from "./provider";
import type { ModelVerifier } from "../pipeline/verify";

/**
 * Mail batches. Nothing reaches the provider until the owner approves a batch
 * (or selected pieces). At send time every piece is checked again: channel
 * open, spend cap, opt-out, two-piece limit, address verified.
 */
export class MailError extends Error {}

export interface BuildOptions {
  cityId: number;
  label?: string;
  limit?: number;
  testMode?: boolean;
  verifier?: ModelVerifier; // tests inject one; production uses the Claude verifier
  renderPdf?: boolean;
}

async function mailedCount(clinicId: string): Promise<number> {
  const [r] = await db()<{ n: number }[]>`select count(*)::int as n from mail_pieces where clinic_id=${clinicId} and mailed_at is not null`;
  return r.n;
}

async function makePiece(batchId: string, clinicId: string, kind: "letter" | "postcard", variant: "A" | "B", cost: number, opts: BuildOptions) {
  const sql = db();
  const data = await buildLetterData(clinicId, kind, variant);
  const gate = await gateLetter(data, { live: !opts.testMode, verifier: opts.verifier });
  const [c] = await sql<{ address: string | null; ok: boolean }[]>`
    select address, (address_confirmed_on_site and address is not null and not address_bad) as ok from clinics where id=${clinicId}`;
  let pdfPath: string | null = null;
  if (opts.renderPdf !== false) {
    // 96 CSS px per inch: letter 8.5 x 11 in, postcard 6 x 4 in
    const r = await htmlToPdfAndThumb(await renderLetter(data), kind === "letter" ? { width: 816, height: 1056 } : { width: 576, height: 384 });
    pdfPath = await putFile(`mail/${batchId}/${clinicId}-${kind}.pdf`, r.pdf, "application/pdf");
    await putFile(`mail/${batchId}/${clinicId}-${kind}.png`, r.png, "image/png");
  }
  const status = !c.ok ? "skipped" : gate.passed ? "draft" : "held";
  const reason = !c.ok ? "no address confirmed on the clinic's own site" : gate.passed ? null : gate.flags.filter((f) => f.severity === "block").map((f) => f.message).join("; ");
  const [p] = await sql<{ id: string }[]>`
    insert into mail_pieces (clinic_id, batch_id, type, status, status_reason, headline_variant, data, gate_flags, gate_passed,
                             address_text, address_status, cost_cents, pdf_path)
    values (${clinicId}, ${batchId}, ${kind}, ${status}, ${reason}, ${variant}, ${sql.json(data as never)}, ${sql.json(gate.flags as never)},
            ${gate.passed}, ${c.address}, 'unverified', ${cost}, ${pdfPath})
    returning id`;
  return { id: p.id, status };
}

/** Build a draft batch of letters for one city from the clinics routing sends to the letter channel. */
export async function buildLetterBatch(opts: BuildOptions) {
  const sql = db();
  const v = await getChannel<LetterValues>("letter");
  const [prior] = await sql<{ n: number }[]>`select count(*)::int as n from mail_batches where status in ('approved','sending','sent') and not test_mode`;
  // the first real batch is capped (default 50 letters, one city)
  const cap = prior.n === 0 ? v.first_batch_max : Math.max(v.first_batch_max, v.daily_cap);
  const limit = Math.min(opts.limit ?? cap, cap);
  const label = opts.label ?? `Letters ${new Date().toISOString().slice(0, 10)}`;
  const facts = await loadFacts(500, opts.cityId);
  // one mail piece per clinic: nothing already in an open batch
  const open = new Set((await sql<{ clinic_id: string }[]>`select clinic_id from mail_pieces where status in ('draft','held','approved','submitted','printing')`).map((r) => r.clinic_id));
  const routes = await assign(facts.filter((f) => !open.has(f.clinicId)), label);
  const chosen = routes.filter((r) => r.channel === "letter").slice(0, limit);
  if (!chosen.length) throw new MailError("no clinic in this city is routed to a letter under the current rules");
  const [batch] = await sql<{ id: string }[]>`
    insert into mail_batches (label, city_id, kind, test_mode) values (${label}, ${opts.cityId}, 'letter', ${opts.testMode ?? true}) returning id`;
  const pieces = [];
  for (let i = 0; i < chosen.length; i++) {
    // A/B inside the letter channel: two headlines split at random within the batch
    const variant = v.headline_test ? (Math.random() < 0.5 ? "A" : "B") : "A";
    pieces.push(await makePiece(batch.id, chosen[i].clinicId, "letter", variant, v.cost_letter_cents, opts));
  }
  return { batchId: batch.id, pieces, skippedByRouting: routes.filter((r) => r.channel === "skipped").length };
}

/** Clinics whose code was not visited within followup_days of the mailed date: one postcard, two pieces at most. */
export async function followUpCandidates(now = new Date()): Promise<string[]> {
  const sql = db();
  const v = await getChannel<LetterValues>("letter");
  const rows = await sql<{ clinic_id: string }[]>`
    select p.clinic_id from mail_pieces p join clinics c on c.id=p.clinic_id
    where p.type='letter' and p.mailed_at is not null and p.returned_at is null
      and p.mailed_at <= ${new Date(now.getTime() - v.followup_days * 86400e3)}
      and c.opted_out_at is null and not c.replied and not c.address_bad and c.status not in ('suppressed','do_not_contact')
      and not exists (select 1 from page_visits pv where pv.clinic_id=p.clinic_id and pv.at >= p.mailed_at)
      and (select count(*) from mail_pieces x where x.clinic_id=p.clinic_id and x.mailed_at is not null) < ${v.max_pieces}
      and not exists (select 1 from mail_pieces x where x.clinic_id=p.clinic_id and x.type='postcard' and x.status not in ('rejected','cancelled','failed'))`;
  return rows.map((r) => r.clinic_id);
}

export async function buildPostcardBatch(opts: Omit<BuildOptions, "cityId"> & { cityId?: number }) {
  const sql = db();
  const v = await getChannel<LetterValues>("letter");
  const ids = await followUpCandidates();
  if (!ids.length) throw new MailError("no clinic is due a follow-up postcard");
  const [batch] = await sql<{ id: string }[]>`
    insert into mail_batches (label, kind, test_mode) values (${opts.label ?? `Postcards ${new Date().toISOString().slice(0, 10)}`}, 'postcard', ${opts.testMode ?? true}) returning id`;
  const pieces = [];
  for (const id of ids.slice(0, opts.limit ?? v.daily_cap)) pieces.push(await makePiece(batch.id, id, "postcard", "A", v.cost_postcard_cents, { ...opts, cityId: 0 }));
  return { batchId: batch.id, pieces };
}

export async function batchCost(batchId: string, onlyIds?: string[]): Promise<{ pieces: number; usd: number }> {
  const [r] = await db()<{ n: number; cents: number }[]>`
    select count(*)::int as n, coalesce(sum(cost_cents),0)::int as cents from mail_pieces
    where batch_id=${batchId} and status in ('draft','approved') and (${onlyIds ?? null}::uuid[] is null or id = any(${onlyIds ?? null}))`;
  return { pieces: r.n, usd: r.cents / 100 };
}

/** Approve all sendable pieces, or only the selected ones. Held and skipped pieces are never approved. */
export async function approveBatch(batchId: string, actor: string, onlyIds?: string[]) {
  const sql = db();
  const [b] = await sql<{ status: string }[]>`select status from mail_batches where id=${batchId}`;
  if (!b) throw new MailError("batch not found");
  if (b.status !== "draft") throw new MailError(`batch is already ${b.status}`);
  const rows = await sql`
    update mail_pieces set status='approved', approved_by=${actor}, approved_at=now(), updated_at=now()
    where batch_id=${batchId} and status='draft' and gate_passed and (${onlyIds ?? null}::uuid[] is null or id = any(${onlyIds ?? null}))
    returning id`;
  if (!rows.length) throw new MailError("nothing in this batch can be approved");
  await sql`update mail_pieces set status='rejected', status_reason='not selected', updated_at=now() where batch_id=${batchId} and status='draft'`;
  await sql`update mail_batches set status='approved', approved_by=${actor}, approved_at=now() where id=${batchId}`;
  await audit("mail_batch", actor, { batch: batchId, status: "draft" }, { status: "approved", pieces: rows.length });
  return rows.length;
}

export async function rejectBatch(batchId: string, actor: string, reason: string) {
  if (!reason.trim()) throw new MailError("a reason is required to reject a batch");
  const sql = db();
  await sql`update mail_batches set status='rejected', reject_reason=${reason.trim()} where id=${batchId} and status='draft'`;
  await sql`update mail_pieces set status='rejected', status_reason=${reason.trim()}, updated_at=now() where batch_id=${batchId} and status in ('draft','held')`;
  await audit("mail_batch", actor, { batch: batchId }, { status: "rejected", reason: reason.trim() });
}

export interface SendSummary {
  submitted: number;
  skipped: { clinicId: string; reason: string }[];
  stopped: string | null;
}

/**
 * Send the approved pieces of an approved batch. In test mode every piece is
 * addressed to the owner's own mailing address (to check print quality).
 */
export async function sendBatch(batchId: string): Promise<SendSummary> {
  const sql = db();
  const [b] = await sql<{ status: string; test_mode: boolean; label: string }[]>`select status, test_mode, label from mail_batches where id=${batchId}`;
  if (!b) throw new MailError("batch not found");
  if (b.status !== "approved" && b.status !== "sending") throw new MailError("this batch has not been approved");
  const provider = mailProvider();
  const v = await getChannel<LetterValues>("letter");
  const owner = ownerDetails();
  if ([owner.name, owner.businessName, owner.mailingAddress].some((x) => OWNER_PLACEHOLDER_RE.test(x))) {
    throw new MailError("your name, business name or mailing address is still a placeholder; they are the return address");
  }
  if (provider.live && !b.test_mode) {
    const [s] = await sql<{ live_enabled: boolean; dry_run: boolean }[]>`select live_enabled, dry_run from app_settings where id`;
    if (!s.live_enabled || s.dry_run) throw new MailError("real mailing is not enabled (dry run). Only test-mode batches can be sent.");
  }
  const from = await provider.verify({ companyName: owner.businessName, firstName: owner.name, line: owner.mailingAddress });
  if (from.status === "failed") throw new MailError("your own mailing address could not be verified");
  await sql`update mail_batches set status='sending' where id=${batchId}`;

  const pieces = await sql<{ id: string; clinic_id: string; type: "letter" | "postcard"; cost_cents: number; pdf_path: string | null; address_text: string | null; data: LetterData }[]>`
    select id, clinic_id, type, cost_cents, pdf_path, address_text, data from mail_pieces where batch_id=${batchId} and status='approved' order by created_at`;
  const out: SendSummary = { submitted: 0, skipped: [], stopped: null };
  const skip = async (id: string, clinicId: string, reason: string, status = "skipped") => {
    await sql`update mail_pieces set status=${status}, status_reason=${reason}, updated_at=now() where id=${id}`;
    out.skipped.push({ clinicId, reason });
  };
  for (const p of pieces) {
    // channel switch, pause, daily cap, monthly spend cap, kill switch
    const gate = await channelOpen("letter", p.cost_cents / 100);
    if (!gate.open) {
      out.stopped = gate.reason;
      break; // remaining pieces stay approved and wait
    }
    if (await isOptedOut(p.clinic_id)) { await skip(p.id, p.clinic_id, "clinic opted out", "cancelled"); continue; }
    if (!b.test_mode && (await mailedCount(p.clinic_id)) >= v.max_pieces) { await skip(p.id, p.clinic_id, `mail limit of ${v.max_pieces} pieces reached`); continue; }
    if (!p.pdf_path) { await skip(p.id, p.clinic_id, "no PDF was rendered"); continue; }
    const pdf = await getFile(p.pdf_path);
    if (!pdf) { await skip(p.id, p.clinic_id, "PDF could not be read"); continue; }

    // verify the address before sending; unverified or undeliverable is skipped and logged, never sent
    let to;
    try {
      to = b.test_mode
        ? from
        : await provider.verify({ companyName: p.data.clinicName, firstName: "Practice Owner", line: p.address_text ?? "" });
    } catch (e) {
      await skip(p.id, p.clinic_id, `address could not be verified: ${(e as Error).message}`);
      continue;
    }
    if (to.status === "failed") {
      await sql`update mail_pieces set address_status='failed' where id=${p.id}`;
      await sql`update clinics set address_bad=true, address_bad_reason='failed address verification' where id=${p.clinic_id}`;
      await skip(p.id, p.clinic_id, "address failed verification");
      continue;
    }
    try {
      const order = await provider.send({
        kind: p.type, toContactId: to.id, fromContactId: from.id, pdf, idempotencyKey: `piece-${p.id}`,
        description: `${b.test_mode ? "TEST " : ""}${b.label} ${p.data.clinicName}`.slice(0, 120),
        color: v.color, mailingClass: v.mailing_class, addressPlacement: v.address_placement,
        metadata: { piece: p.id, test: String(b.test_mode) },
      });
      // a test-mode piece went to the owner, not the clinic: it never counts as mail to the clinic
      await sql`update mail_pieces set status='submitted', provider=${provider.name}, provider_id=${order.id}, provider_contact_id=${to.id},
                address_status=${b.test_mode ? "test: owner address" : to.status}, mailed_at=${b.test_mode ? null : new Date()}, updated_at=now()
                where id=${p.id}`;
      await sql`insert into cost_records (clinic_id, provider, operation, units, cost_usd)
                values (${p.clinic_id}, 'postgrid', ${p.type}, ${sql.json({ test: b.test_mode, live: provider.live })}, ${provider.live ? p.cost_cents / 100 : 0})`;
      if (!b.test_mode) await sql`update clinics set status='contacted', updated_at=now() where id=${p.clinic_id} and status in ('queued','teaser_built')`;
      out.submitted++;
    } catch (e) {
      await skip(p.id, p.clinic_id, (e as Error).message, "failed");
    }
  }
  if (!out.stopped) await sql`update mail_batches set status='sent' where id=${batchId}`;
  return out;
}

/** Provider webhook: created, printed, mailed; returned where the provider reports it. */
export async function applyProviderEvent(evt: { type: string; data: { id: string; status: string; imbStatus?: string | null } }) {
  const sql = db();
  const map: Record<string, string> = { ready: "submitted", printing: "printing", processed_for_delivery: "mailed", completed: "delivered_est", cancelled: "cancelled" };
  if (evt.data.imbStatus === "returned_to_sender") return markReturnedByProviderId(evt.data.id, "returned to sender (provider)");
  const status = map[evt.data.status];
  if (!status) return false;
  const r = await sql`
    update mail_pieces set status=${status}, updated_at=now(),
      mailed_at = case when ${status} in ('mailed','delivered_est') and mailed_at is null and address_status not like 'test:%' then now() else mailed_at end
    where provider_id=${evt.data.id} and status not in ('returned') returning id`;
  return r.length > 0;
}

async function markReturnedByProviderId(providerId: string, reason: string) {
  const [p] = await db()<{ id: string }[]>`select id from mail_pieces where provider_id=${providerId}`;
  if (!p) return false;
  await markReturned(p.id, reason);
  return true;
}

/** Returned mail marks the address as bad. For Canada this is recorded by hand when the piece comes back. */
export async function markReturned(pieceId: string, reason = "returned to sender") {
  const sql = db();
  const [p] = await sql<{ clinic_id: string }[]>`
    update mail_pieces set status='returned', returned_at=now(), status_reason=${reason}, updated_at=now() where id=${pieceId} returning clinic_id`;
  if (p) await sql`update clinics set address_bad=true, address_bad_reason=${reason}, updated_at=now() where id=${p.clinic_id}`;
}
