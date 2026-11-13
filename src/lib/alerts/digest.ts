import { db } from "../db";
import { daysBetween, isBusinessDay, localDate, torontoToUtc, TZ } from "../time";
import { getSettings } from "../settings";
import { queueOwnerMail } from "../sending/outbox";
import { upcomingRetests } from "../retests/due";
import { portalUrl } from "./raise";

/**
 * The owner's morning digest: plain text, short, with portal links. Sent on
 * business days at digest_hour_local (Toronto). "Since" is the start of the
 * previous business day, so Monday's digest covers Friday and the weekend.
 * Nothing is sent when there is nothing at all to report.
 */

export interface Digest {
  day: string;
  subject: string;
  body: string;
  empty: boolean;
  counts: Record<string, number>;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Start of the business day before `now`'s day, and the start of today (UTC instants). */
export function digestWindow(now: Date): { from: Date; to: Date; label: string } {
  const today = localDate(now);
  const to = torontoToUtc(today, "00:00");
  let from = to;
  do {
    from = torontoToUtc(localDate(new Date(from.getTime() - 12 * 3600e3)), "00:00");
  } while (!isBusinessDay(new Date(from.getTime() + 12 * 3600e3)));
  const days = daysBetween(localDate(new Date(from.getTime() + 12 * 3600e3)), today);
  const label = days === 1 ? "yesterday"
    : `since ${new Intl.DateTimeFormat("en-CA", { timeZone: TZ, weekday: "long" }).format(new Date(from.getTime() + 12 * 3600e3))}`;
  return { from, to, label };
}

export async function buildDigest(now: Date = new Date()): Promise<Digest> {
  const sql = db();
  const day = localDate(now);
  const w = digestWindow(now);
  const monthStart = torontoToUtc(`${day.slice(0, 7)}-01`, "00:00");
  const s = await getSettings();

  const [c] = await sql<Record<string, number>[]>`
    select
      (select count(*) from messages where status = 'pending_review')::int as waiting,
      (select count(*) from messages where status = 'held')::int as held_items,
      (select count(*) from clinics where status = 'held')::int as held_clinics,
      (select count(*) from messages where sent_at >= ${w.from} and sent_at < ${w.to} and type not in ('owner_alert', 'owner_digest'))::int as sent,
      (select count(*) from messages where bounced_at >= ${w.from} and bounced_at < ${w.to})::int as bounces,
      (select count(*) from messages where complained_at >= ${w.from} and complained_at < ${w.to})::int as complaints,
      (select count(*) from inbound_messages where received_at >= ${w.from} and received_at < ${w.to}
         and coalesce(classification::text, '') <> 'auto_reply')::int as replies,
      (select count(*) from inbound_messages where not handled and coalesce(classification::text, '') <> 'auto_reply')::int as replies_open,
      (select count(*) from orders where status = 'paid' and paid_at >= ${w.from} and paid_at < ${w.to})::int as orders,
      (select coalesce(sum(amount_cents), 0) from orders where status = 'paid' and paid_at >= ${w.from} and paid_at < ${w.to})::int as order_cents,
      (select count(*) from subscriptions where created_at >= ${w.from} and created_at < ${w.to})::int as new_subscriptions,
      (select count(*) from jobs where status = 'dead')::int as dead_jobs,
      (select count(*) from owner_tasks where status = 'open')::int as open_tasks,
      (select coalesce(sum(cost_usd), 0) from cost_records where at >= ${w.from} and at < ${w.to})::float as spend_window,
      (select coalesce(sum(cost_usd), 0) from cost_records where at >= ${monthStart} and at < ${now})::float as spend_month`;
  const tasks = await sql<{ title: string }[]>`select title from owner_tasks where status = 'open' order by created_at desc limit 5`;
  const weekEnd = localDate(new Date(now.getTime() + 6 * 86400e3));
  const retests = (await upcomingRetests(now)).filter((r) => r.due >= day && r.due <= weekEnd);

  const lines: string[] = [];
  const add = (show: boolean, line: string) => { if (show) lines.push(line); };
  add(c.waiting > 0, `Waiting for your review: ${c.waiting}  ${portalUrl()}`);
  add(c.held_items + c.held_clinics > 0,
    `Held by the verification gate: ${plural(c.held_items, "item", "items")}, ${plural(c.held_clinics, "clinic", "clinics")}  ${portalUrl("/held")}`);
  add(c.sent + c.bounces + c.complaints > 0,
    `Sent ${w.label}: ${c.sent} (${plural(c.bounces, "bounce", "bounces")}, ${plural(c.complaints, "complaint", "complaints")})  ${portalUrl("/sent")}`);
  add(c.replies + c.replies_open > 0, `New replies ${w.label}: ${c.replies}; not handled yet: ${c.replies_open}  ${portalUrl("/replies")}`);
  add(c.orders + c.new_subscriptions > 0,
    `New ${w.label}: ${plural(c.orders, "paid order", "paid orders")} (${(c.order_cents / 100).toFixed(2)} CAD), ${plural(c.new_subscriptions, "new subscription", "new subscriptions")}  ${portalUrl("/overview")}`);
  if (retests.length) {
    lines.push(`Monthly reports due in the next 7 days: ${retests.length}  ${portalUrl("/system")}`);
    for (const r of retests.slice(0, 8)) lines.push(`  - ${r.clinicName}: ${r.due}${r.grace ? " (payment past due)" : ""}`);
  }
  add(c.dead_jobs > 0, `Jobs that failed for good: ${c.dead_jobs}  ${portalUrl("/system")}`);
  if (c.open_tasks > 0) {
    lines.push(`Open tasks: ${c.open_tasks}  ${portalUrl("/system")}`);
    for (const t of tasks) lines.push(`  - ${t.title}`);
  }
  const empty = lines.length === 0 && c.spend_window === 0;
  lines.push(`API spend ${w.label}: ${c.spend_window.toFixed(2)} USD; this month so far: ${c.spend_month.toFixed(2)} USD (daily cap ${Number(s.claude_daily_spend_cap_usd).toFixed(2)})`);
  const state = [s.kill_switch ? "Kill switch is ON." : "", s.auto_paused ? `Sending is paused: ${s.auto_pause_reason ?? "see Settings"}.` : ""].filter(Boolean);

  return {
    day,
    subject: `In The Answer: ${day}${c.waiting ? `, ${c.waiting} to review` : ""}`,
    body: [`In The Answer, ${day}`, "", ...state, ...lines, "", portalUrl()].join("\n"),
    empty: empty && state.length === 0,
    counts: { ...c, retests_due: retests.length },
  };
}

/** Queue today's digest. Idempotent per day (the mail key and the notification row). */
export async function sendDigest(now: Date = new Date()): Promise<{ sent: boolean; reason?: string }> {
  if (!isBusinessDay(now)) return { sent: false, reason: "not a business day" };
  const d = await buildDigest(now);
  if (d.empty) return { sent: false, reason: "nothing to report" };
  const sql = db();
  await sql`insert into owner_notifications (kind, day, detail) values ('digest', ${d.day}, ${sql.json(d.counts as never)})
            on conflict (kind, day) do nothing`;
  const m = await queueOwnerMail("owner_digest", d.day, d.subject, d.body);
  return { sent: m.created };
}
