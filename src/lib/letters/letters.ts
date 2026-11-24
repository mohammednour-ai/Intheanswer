import { db } from "../db";
import { env, ownerDetails } from "../env";
import { enqueue, PermanentJobError, type JobContext } from "../jobs/queue";
import { getSettings, type AppSettings } from "../settings";
import { formatLongDate } from "../time";
import { callOffer } from "../calls/request";
import { htmlToPdf } from "../reports/pdf";
import type { TeaserData } from "../reports/types";
import type { Flag } from "../pipeline/verify";
import { buildLetter, checkLetter, newLetterCode, renderLetterHtml } from "./content";
import { mailProvider } from "./provider";
import { letterFits } from "./measure";

/**
 * Letters by post (owner's decision of 23 November 2026): one letter per clinic, ever, to a clinic
 * that was emailed `letter_after_days` ago and has not answered in any way. Each business day the
 * scheduler prepares up to `letters_per_day`; nothing is posted until the owner approves a letter in
 * Portal > Letters, and the clinic is checked again at that moment.
 *
 * Until `letters_live` is on, PostGrid is only used for copies to the owner's own address: a letter
 * to a clinic is refused if the key is live.
 */

type Sql = ReturnType<typeof db>;

export const letterSettings = (s: AppSettings) => ({
  enabled: s.letters_enabled === true,
  live: s.letters_live === true,
  afterDays: Math.max(1, Number(s.letter_after_days ?? 14)),
  perDay: Math.max(0, Number(s.letters_per_day ?? 10)),
  mailingClass: s.letter_mailing_class || "ca_post_lettermail",
  costUsd: Number(s.letter_cost_usd ?? 2.22),
  budgetUsd: Number(s.letters_monthly_budget_usd ?? 100),
});

/**
 * The clinic may get a letter: emailed long enough ago, and since then no reply, no opened report,
 * no call, no purchase, no opt-out of any kind. `c` is the clinics row alias.
 */
const mayGetLetter = (sql: Sql, afterDays: number) => sql`
  c.status not in ('customer', 'do_not_contact', 'suppressed', 'closed', 'excluded', 'replied')
  and c.address_confirmed_on_site and coalesce(c.address, '') ~ '[0-9]'
  and exists (select 1 from messages m where m.clinic_id = c.id and m.type = 'first_email' and m.status = 'sent'
              and not m.dry_run and m.sent_at <= now() - make_interval(days => ${afterDays}))
  and not exists (select 1 from messages m where m.clinic_id = c.id and (m.replied_at is not null or m.complained_at is not null))
  and not exists (select 1 from inbound_messages i where i.clinic_id = c.id)
  and not exists (select 1 from reports r where r.clinic_id = c.id and (r.view_count > 0 or r.first_viewed_at is not null))
  and not exists (select 1 from calls k where k.clinic_id = c.id)
  and not exists (select 1 from call_suppressions k where k.clinic_id = c.id)
  and not exists (select 1 from orders o where o.clinic_id = c.id)
  and not exists (select 1 from subscriptions s where s.clinic_id = c.id)
  and not exists (
    select 1 from suppressions x
    where x.source <> 'bounce'
      and ((x.kind = 'domain' and x.value = c.domain)
        or (x.kind = 'address' and x.value in (
              select lower(email) from contacts where clinic_id = c.id
              union select lower(to_email) from messages where clinic_id = c.id)))
  )`;

interface TeaserRow {
  id: string;
  data: TeaserData & { verified?: boolean };
}

async function latestTeaser(sql: Sql, clinicId: string): Promise<TeaserRow | null> {
  const [r] = await sql<TeaserRow[]>`
    select id, data from reports where clinic_id = ${clinicId} and kind = 'teaser' and not superseded
    order by created_at desc limit 1`;
  return r ?? null;
}

/** Prepare one clinic's letter: rendered, checked, and left for the owner (or held, with the reasons). */
export async function prepareLetter(clinicId: string, now = new Date()): Promise<{ id: string; status: "review" | "held" } | null> {
  const sql = db();
  const [c] = await sql<{ name: string; address: string }[]>`select name, address from clinics where id = ${clinicId}`;
  const teaser = await latestTeaser(sql, clinicId);
  if (!c || !teaser) return null;
  const [m] = await sql<{ id: string; sent_at: Date }[]>`
    select id, sent_at from messages where clinic_id = ${clinicId} and type = 'first_email' and status = 'sent' and not dry_run
    order by sent_at limit 1`;
  const offer = await callOffer(teaser.id).catch(() => null);
  const code = newLetterCode();
  const date = formatLongDate(now);
  const letter = buildLetter({
    data: teaser.data, code, date,
    emailedOn: m ? formatLongDate(m.sent_at) : null,
    phone: offer?.phone ? { display: offer.phone.display, code: offer.phone.code } : null,
  });
  const flags: Flag[] = checkLetter(letter, teaser.data, c.address);
  const html = await renderLetterHtml(letter, date);
  if (!(await letterFits(html))) flags.push({ code: "letter_too_long", message: "the letter does not fit on one page", severity: "block" });
  const passed = !flags.some((f) => f.severity === "block");
  const [row] = await sql<{ id: string }[]>`
    insert into letters (clinic_id, report_id, after_message_id, code, status, to_name, to_address, html, flags, gate_passed)
    values (${clinicId}, ${teaser.id}, ${m?.id ?? null}, ${code}, ${passed ? "review" : "held"}, ${c.name}, ${c.address}, ${html},
            ${sql.json(flags as never)}, ${passed})
    on conflict do nothing returning id`;
  return row ? { id: row.id, status: passed ? "review" : "held" } : null;
}

/** The scheduler's daily run: prepare letters for the clinics that qualify, up to the day's number. */
export async function prepareLetters(now = new Date(), opts: { limit?: number } = {}): Promise<{ prepared: number; held: number }> {
  const s = letterSettings(await getSettings());
  if (!s.enabled) return { prepared: 0, held: 0 };
  const sql = db();
  const [today] = await sql<{ n: number }[]>`
    select count(*)::int as n from letters where (created_at at time zone 'America/Toronto')::date = (now() at time zone 'America/Toronto')::date`;
  const room = Math.max(0, Math.min(opts.limit ?? s.perDay, s.perDay - today.n));
  if (!room) return { prepared: 0, held: 0 };
  const clinics = await sql<{ id: string }[]>`
    select c.id from clinics c
    where ${mayGetLetter(sql, s.afterDays)}
      and not exists (select 1 from letters l where l.clinic_id = c.id)
    order by (select min(sent_at) from messages m where m.clinic_id = c.id and m.type = 'first_email' and m.status = 'sent')
    limit ${room}`;
  let prepared = 0;
  let held = 0;
  for (const c of clinics) {
    const r = await prepareLetter(c.id, now);
    if (r?.status === "review") prepared++;
    if (r?.status === "held") held++;
  }
  return { prepared, held };
}

/** Whether the clinic still qualifies (checked again when the owner approves, and before posting). */
export async function stillQualifies(clinicId: string): Promise<boolean> {
  const sql = db();
  const s = letterSettings(await getSettings());
  const [r] = await sql<{ ok: boolean }[]>`select exists (select 1 from clinics c where c.id = ${clinicId} and ${mayGetLetter(sql, s.afterDays)}) as ok`;
  return r.ok;
}

export async function spentThisMonthUsd(): Promise<number> {
  const [r] = await db()<{ usd: string | null }[]>`
    select sum(cost_usd) as usd from letters
    where status = 'sent' and live and date_trunc('month', sent_at at time zone 'America/Toronto') = date_trunc('month', now() at time zone 'America/Toronto')`;
  return Number(r.usd ?? 0);
}

export type ApproveResult = { ok: true } | { ok: false; message: string };

/** The owner approves a letter: checked again, then posted by the worker within a minute or two. */
export async function approveLetter(id: string): Promise<ApproveResult> {
  const sql = db();
  const [l] = await sql<{ status: string; gate_passed: boolean; clinic_id: string; report_id: string }[]>`
    select status, gate_passed, clinic_id, report_id from letters where id = ${id}`;
  if (!l) return { ok: false, message: "Letter not found." };
  if (l.status !== "review" || !l.gate_passed) return { ok: false, message: "Only a letter waiting for approval can be approved." };
  const settings = letterSettings(await getSettings());
  if (!mailProvider()) return { ok: false, message: "Add the PostGrid key (POSTGRID_API_KEY) first." };
  const [rep] = await sql<{ ok: boolean }[]>`select (not superseded and data->>'verified' = 'true') as ok from reports where id = ${l.report_id}`;
  if (!rep?.ok) {
    await cancel(id, "the clinic's report changed since the letter was prepared");
    return { ok: false, message: "The clinic's report changed since this letter was prepared, so it was cancelled. A new one is prepared if the clinic still qualifies." };
  }
  if (!(await stillQualifies(l.clinic_id))) {
    await cancel(id, "the clinic no longer qualifies (it replied, opened its report, called, bought or opted out)");
    return { ok: false, message: "The clinic no longer qualifies (it replied, opened its report, called, bought or opted out), so the letter was cancelled." };
  }
  if (settings.live && (await spentThisMonthUsd()) + settings.costUsd > settings.budgetUsd) {
    return { ok: false, message: `This would pass the monthly limit of US$${settings.budgetUsd.toFixed(2)} for letters.` };
  }
  const set = await sql`update letters set status = 'approved', approved_at = now(), updated_at = now() where id = ${id} and status = 'review' returning id`;
  if (set.length) await enqueue("send_letter", `send_letter:${id}`, { letterId: id }, { maxAttempts: 3 });
  return { ok: true };
}

async function cancel(id: string, reason: string): Promise<void> {
  await db()`update letters set status = 'cancelled', reject_reason = ${reason}, updated_at = now()
             where id = ${id} and status in ('review', 'held', 'approved')`;
}

export async function rejectLetter(id: string, reason: string): Promise<void> {
  await cancel(id, reason.trim().slice(0, 300) || "rejected by the owner");
}

function ownerAddress() {
  const o = ownerDetails();
  return { companyName: o.businessName, firstName: o.name, line: o.mailingAddress };
}

/**
 * The worker posts an approved letter. A failed address check or a live key while real mailing is
 * off stops it (status failed, with the reason) instead of retrying.
 */
export async function postLetter(id: string, ctx?: JobContext): Promise<{ orderId: string; live: boolean }> {
  const sql = db();
  const [l] = await sql<{ status: string; clinic_id: string; to_name: string; to_address: string; html: string; code: string; provider_order_id: string | null }[]>`
    select status, clinic_id, to_name, to_address, html, code, provider_order_id from letters where id = ${id}`;
  if (!l) throw new PermanentJobError("letter not found");
  if (l.status !== "approved") return { orderId: l.provider_order_id ?? "", live: false };
  const fail = async (message: string) => {
    await sql`update letters set status = 'failed', last_error = ${message}, updated_at = now() where id = ${id}`;
    throw new PermanentJobError(message);
  };
  const p = mailProvider();
  if (!p) return fail("no PostGrid key (POSTGRID_API_KEY)");
  const s = letterSettings(await getSettings());
  if (!(await stillQualifies(l.clinic_id))) {
    await cancel(id, "the clinic no longer qualifies (checked just before posting)");
    return { orderId: "", live: false };
  }
  const to = await p.contact({ companyName: l.to_name, line: l.to_address });
  if (to.live && !s.live) return fail("real mailing is off (Portal > Letters): a live PostGrid key would have printed and posted this letter");
  await sql`update letters set provider = ${p.name}, provider_contact_id = ${to.id}, address_status = ${to.status},
            address_normalized = ${to.normalized}, updated_at = now() where id = ${id}`;
  if (to.status === "failed") return fail(`Canada Post address check failed: ${to.errors ?? "address not found"}`);
  const from = await p.contact(ownerAddress());
  const pdf = await htmlToPdf(l.html);
  const order = await p.letter({
    to: to.id, from: from.id, pdf, idempotencyKey: `letter:${id}`, mailingClass: s.mailingClass,
    description: `In The Answer letter ${l.code}`, metadata: { letterId: id, clinicId: l.clinic_id },
  });
  await sql`update letters set status = 'sent', sent_at = now(), provider_order_id = ${order.id}, provider_status = ${order.status},
            live = ${order.live}, mailing_class = ${s.mailingClass}, cost_usd = ${order.live ? s.costUsd : 0}, last_error = null, updated_at = now()
            where id = ${id}`;
  await ctx?.log(`letter ${id} posted as ${order.id} (${order.live ? "live" : "test"})`);
  return { orderId: order.id, live: order.live };
}

/** A copy of the letter to the owner's own address (with a live key it is really printed and posted to you). */
export async function sendTestCopy(id: string): Promise<{ ok: true; live: boolean } | { ok: false; message: string }> {
  const sql = db();
  const p = mailProvider();
  if (!p) return { ok: false, message: "Add the PostGrid key (POSTGRID_API_KEY) first." };
  const [l] = await sql<{ html: string; code: string; test_orders: unknown[] }[]>`select html, code, test_orders from letters where id = ${id}`;
  if (!l) return { ok: false, message: "Letter not found." };
  if (l.test_orders.length >= 3) return { ok: false, message: "Three copies of this letter were already sent to you." };
  const s = letterSettings(await getSettings());
  const me = await p.contact(ownerAddress());
  if (me.status === "failed") return { ok: false, message: `Canada Post could not check your own address (OWNER_MAILING_ADDRESS): ${me.errors ?? "not found"}.` };
  const pdf = await htmlToPdf(l.html);
  const order = await p.letter({
    to: me.id, from: me.id, pdf, idempotencyKey: `letter-copy:${id}:${l.test_orders.length + 1}`, mailingClass: s.mailingClass,
    description: `Copy of In The Answer letter ${l.code}`, metadata: { letterId: id, copy: "owner" },
  });
  const entry = { at: new Date().toISOString(), orderId: order.id, live: order.live };
  await sql`update letters set test_orders = test_orders || ${sql.json([entry] as never)}, updated_at = now() where id = ${id}`;
  return { ok: true, live: order.live };
}

/** PostGrid's status updates. A letter cancelled at PostGrid is marked cancelled here. */
export async function applyMailEvent(orderId: string, status: string): Promise<boolean> {
  const sql = db();
  const r = await sql`
    update letters set provider_status = ${status},
      completed_at = case when ${status} = 'completed' then coalesce(completed_at, now()) else completed_at end,
      status = case when ${status} = 'cancelled' then 'cancelled' else status end,
      reject_reason = case when ${status} = 'cancelled' then coalesce(reject_reason, 'cancelled at PostGrid') else reject_reason end,
      updated_at = now()
    where provider_order_id = ${orderId} returning id`;
  return r.length > 0;
}

/** Someone opened intheanswer.ca/l/<code>: count it and return the report's address. */
export async function letterVisit(code: string, counted: boolean): Promise<{ reportToken: string } | null> {
  const sql = db();
  const [l] = await sql<{ id: string; token: string; status: string }[]>`
    select l.id, r.token, l.status from letters l join reports r on r.id = l.report_id where l.code = ${code}`;
  if (!l || l.status !== "sent") return null;
  if (counted) await sql`update letters set visit_count = visit_count + 1, first_visit_at = coalesce(first_visit_at, now()), updated_at = now() where id = ${l.id}`;
  return { reportToken: l.token };
}

export async function letterForStop(code: string): Promise<{ id: string; clinicId: string; clinicName: string; stopped: boolean } | null> {
  const [l] = await db()<{ id: string; clinic_id: string; to_name: string; stopped_at: Date | null; status: string }[]>`
    select id, clinic_id, to_name, stopped_at, status from letters where code = ${code}`;
  if (!l || l.status !== "sent") return null;
  return { id: l.id, clinicId: l.clinic_id, clinicName: l.to_name, stopped: !!l.stopped_at };
}

export function postgridConfigured(): { key: boolean; webhook: boolean } {
  return { key: !!env().POSTGRID_API_KEY, webhook: !!env().POSTGRID_WEBHOOK_SECRET };
}
