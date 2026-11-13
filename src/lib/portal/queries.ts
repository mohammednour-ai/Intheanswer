import { db } from "../db";
import { localDate } from "../time";
import { ORDER_SQL } from "../sending/priority";

export interface QueueItem {
  id: string;
  type: string;
  status: string;
  subject: string;
  to_email: string;
  created_at: Date;
  expires_at: Date | null;
  flags: { code: string; message: string; severity: string }[];
  review_reason: string | null;
  clinic_id: string | null;
  clinic_name: string | null;
  city: string | null;
  sector: string | null;
  score: string | null;
  priority_score: number | null;
  priority_manual: number | null;
  priority_breakdown: { label: string; points: number; max: number; available: boolean; why: string }[] | null;
}

const ITEM_COLUMNS = (sql: ReturnType<typeof db>) => sql`
  m.id, m.type, m.status, m.subject, m.to_email, m.created_at, m.expires_at, m.flags, m.review_reason,
  m.clinic_id, c.priority_score, c.priority_manual, c.priority_breakdown, c.name as clinic_name, ci.name as city, se.name as sector,
  (select sc.recommended || ' of ' || sc.total from scores sc where sc.clinic_id = c.id
     order by sc.created_at desc limit 1) as score`;

export async function listMessages(statuses: string[], limit = 100): Promise<QueueItem[]> {
  const sql = db();
  // the review and send queues follow the send order; history lists are newest first
  const bySendOrder = statuses.some((x) => x === "pending_review" || x === "approved");
  return sql<QueueItem[]>`
    select ${ITEM_COLUMNS(sql)}
    from messages m
    left join clinics c on c.id = m.clinic_id
    left join cities ci on ci.id = c.city_id
    left join sectors se on se.id = c.sector_id
    where m.status = any(${statuses})
    order by ${bySendOrder ? sql.unsafe(ORDER_SQL) : sql`m.created_at desc`}
    limit ${limit}`;
}

export async function getMessage(id: string) {
  const sql = db();
  const [m] = await sql`
    select m.*, c.name as clinic_name, c.website, c.domain, ci.name as city, se.name as sector,
           r.token as report_token, r.kind as report_kind
    from messages m
    left join clinics c on c.id = m.clinic_id
    left join cities ci on ci.id = c.city_id
    left join sectors se on se.id = c.sector_id
    left join reports r on r.id = m.report_id
    where m.id = ${id}`;
  if (!m) return null;
  const log = await sql`select * from approval_log where message_id = ${id} order by at desc`;
  const events = await sql`select type, occurred_at from message_events where message_id = ${id} order by occurred_at`;
  return { message: m, log, events };
}

export async function listReplies(limit = 100) {
  const sql = db();
  return sql`
    select i.*, c.name as clinic_name, d.id as draft_message_id, d.status::text as draft_status
    from inbound_messages i
    left join clinics c on c.id = i.clinic_id
    left join lateral (select id, status from messages where inbound_id = i.id order by created_at desc limit 1) d on true
    order by i.received_at desc limit ${limit}`;
}

export async function listHeldClinics(limit = 100) {
  const sql = db();
  return sql`
    select c.id, c.name, c.status, c.status_reason, c.source::text as source, c.updated_at, ci.name as city, se.name as sector
    from clinics c left join cities ci on ci.id = c.city_id left join sectors se on se.id = c.sector_id
    where c.status = 'held' order by c.updated_at desc limit ${limit}`;
}

export async function overview() {
  const sql = db();
  const funnel = await sql<{ status: string; n: number }[]>`
    select status::text, count(*)::int as n from clinics group by status order by status`;
  const messages = await sql<{ status: string; n: number }[]>`
    select status::text, count(*)::int as n from messages group by status`;
  const [rev] = await sql<{ one_time_cents: number; subs_active: number }[]>`
    select
      coalesce((select sum(amount_cents) from orders where kind='one_time' and status='paid'), 0)::int as one_time_cents,
      (select count(*) from subscriptions where status in ('active','past_due','trialing'))::int as subs_active`;
  const costPerDay = await sql<{ day: string; usd: number }[]>`
    select to_char(date_trunc('day', at at time zone 'America/Toronto'), 'YYYY-MM-DD') as day,
           sum(cost_usd)::float as usd
    from cost_records where at > now() - interval '14 days' group by 1 order by 1 desc`;
  const [perClinic] = await sql<{ avg_usd: number | null; clinics: number }[]>`
    select avg(t)::float as avg_usd, count(*)::int as clinics from (
      select clinic_id, sum(cost_usd) as t from cost_records where clinic_id is not null group by clinic_id) x`;
  const [shared] = await sql<{ usd: number | null }[]>`
    select sum(cost_usd)::float as usd from cost_records where clinic_id is null`;
  const [today] = await sql<{ usd: number | null }[]>`
    select sum(cost_usd)::float as usd from cost_records
    where provider='anthropic' and (at at time zone 'America/Toronto')::date = ${localDate(new Date())}::date`;
  const jobs = await sql<{ kind: string; status: string; n: number }[]>`
    select kind, status::text, count(*)::int as n from jobs group by kind, status order by kind, status`;
  return { funnel, messages, rev, costPerDay, perClinic, sharedCostUsd: shared.usd ?? 0, claudeTodayUsd: today.usd ?? 0, jobs };
}

export async function countWaiting(): Promise<number> {
  const [r] = await db()<{ n: number }[]>`select count(*)::int as n from messages where status='pending_review'`;
  return r.n;
}
