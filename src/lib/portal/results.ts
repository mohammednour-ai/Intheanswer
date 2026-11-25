import { db } from "../db";

/**
 * Outreach results by day, week or month, in the owner's time zone: what went out, and what came
 * back. Only real activity is counted: dry runs, the owner's own report views and calls from the
 * owner's own numbers (Settings > phone test numbers) are left out.
 */

export type Period = "day" | "week" | "month";
export const PERIODS: Period[] = ["day", "week", "month"];
const SPAN: Record<Period, number> = { day: 30, week: 12, month: 12 };

export interface ResultRow {
  start: string; // yyyy-mm-dd, local
  emails: number; // first emails and follow-ups sent
  bounced: number;
  replies: number; // every reply from a clinic except automatic ones
  positive: number; // interested, or asked a question
  negative: number; // not interested, or asked to be removed
  viewers: number; // clinics that opened their report
  returning: number; // ... and had opened it on an earlier day
  calls: number; // calls with a clinic (either direction), not the owner's own
  letters: number;
  purchases: number;
}

/**
 * Report opens by a person. Left out: the owner's own visits, and any open within LINK_CHECK of the
 * email that carried the link, which is the recipient's mail system checking the link (on
 * 23-24 November three of the first opens came 4 to 23 seconds after sending).
 */
const LINK_CHECK = "2 minutes";
function realViews(tz: string) {
  return db()`
    select r.clinic_id, (v.viewed_at at time zone ${tz}) as t, (v.viewed_at at time zone ${tz})::date as d
    from report_views v join reports r on r.id = v.report_id
    where not v.is_owner and r.clinic_id is not null
      and not exists (select 1 from messages m where m.report_id = r.id and m.sent_at is not null
                      and v.viewed_at >= m.sent_at and v.viewed_at < m.sent_at + ${LINK_CHECK}::interval)`;
}

export async function outreachResults(by: Period, now = new Date()): Promise<{ rows: ResultRow[]; totals: ResultRow; firstEmails: number }> {
  const sql = db();
  const n = SPAN[by];
  const [s] = await sql<{ tz: string; owner_numbers: string[] }[]>`
    select coalesce(timezone, 'America/Toronto') as tz, coalesce(call_relay_numbers, '{}') as owner_numbers from app_settings limit 1`;
  const tz = s?.tz ?? "America/Toronto";
  const owner = s?.owner_numbers ?? [];
  const step = `1 ${by}`;
  const rows = await sql<ResultRow[]>`
    with p as (
      select g as s, g + ${step}::interval as e
      from generate_series(date_trunc(${by}, ${now}::timestamptz at time zone ${tz}) - (${n - 1}::int * ${step}::interval),
                           date_trunc(${by}, ${now}::timestamptz at time zone ${tz}), ${step}::interval) g
    ),
    views as (${realViews(tz)})
    select to_char(p.s, 'YYYY-MM-DD') as start,
      (select count(*) from messages m where m.type in ('first_email', 'follow_up') and m.status = 'sent' and not m.dry_run
         and (m.sent_at at time zone ${tz}) >= p.s and (m.sent_at at time zone ${tz}) < p.e)::int as emails,
      (select count(*) from messages m where m.type in ('first_email', 'follow_up') and not m.dry_run and m.bounced_at is not null
         and (m.bounced_at at time zone ${tz}) >= p.s and (m.bounced_at at time zone ${tz}) < p.e)::int as bounced,
      (select count(*) from inbound_messages i where i.clinic_id is not null and i.classification is distinct from 'auto_reply'
         and (i.received_at at time zone ${tz}) >= p.s and (i.received_at at time zone ${tz}) < p.e)::int as replies,
      (select count(*) from inbound_messages i where i.clinic_id is not null and i.classification in ('interested', 'question')
         and (i.received_at at time zone ${tz}) >= p.s and (i.received_at at time zone ${tz}) < p.e)::int as positive,
      (select count(*) from inbound_messages i where i.clinic_id is not null and i.classification in ('not_interested', 'unsubscribe')
         and (i.received_at at time zone ${tz}) >= p.s and (i.received_at at time zone ${tz}) < p.e)::int as negative,
      (select count(distinct v.clinic_id) from views v where v.t >= p.s and v.t < p.e)::int as viewers,
      (select count(distinct v.clinic_id) from views v where v.t >= p.s and v.t < p.e
         and exists (select 1 from views w where w.clinic_id = v.clinic_id and w.d < v.d))::int as returning,
      (select count(*) from calls c where c.status = 'completed' and not c.dry_run and c.phone <> all(${owner}::text[])
         and (c.started_at at time zone ${tz}) >= p.s and (c.started_at at time zone ${tz}) < p.e)::int as calls,
      (select count(*) from letters l where l.status = 'sent' and l.live
         and (l.sent_at at time zone ${tz}) >= p.s and (l.sent_at at time zone ${tz}) < p.e)::int as letters,
      (select count(*) from orders o where o.paid_at is not null
         and (o.paid_at at time zone ${tz}) >= p.s and (o.paid_at at time zone ${tz}) < p.e)::int as purchases
    from p order by p.s desc`;
  const out: ResultRow[] = [...rows];
  // the totals since the first email, not only over the rows shown
  const [t] = await sql<(Omit<ResultRow, "start"> & { first_emails: number })[]>`
    select
      (select count(*) from messages where type in ('first_email', 'follow_up') and status = 'sent' and not dry_run)::int as emails,
      (select count(*) from messages where type = 'first_email' and status = 'sent' and not dry_run)::int as first_emails,
      (select count(*) from messages where type in ('first_email', 'follow_up') and not dry_run and bounced_at is not null)::int as bounced,
      (select count(*) from inbound_messages where clinic_id is not null and classification is distinct from 'auto_reply')::int as replies,
      (select count(*) from inbound_messages where clinic_id is not null and classification in ('interested', 'question'))::int as positive,
      (select count(*) from inbound_messages where clinic_id is not null and classification in ('not_interested', 'unsubscribe'))::int as negative,
      (select count(distinct clinic_id) from (${realViews(tz)}) v)::int as viewers,
      (select count(*) from (select clinic_id from (${realViews(tz)}) v group by clinic_id having count(distinct d) > 1) x)::int as returning,
      (select count(*) from calls where status = 'completed' and not dry_run and phone <> all(${owner}::text[]))::int as calls,
      (select count(*) from letters where status = 'sent' and live)::int as letters,
      (select count(*) from orders where paid_at is not null)::int as purchases`;
  const { first_emails, ...totals } = t;
  return { rows: out, totals: { start: "", ...totals }, firstEmails: first_emails };
}
