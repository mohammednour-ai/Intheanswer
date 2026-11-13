import { db } from "../db";

/**
 * Funnel per channel, batch, city, test arm and letter headline:
 * contacted -> delivered (estimated for mail) -> visited -> requested a call
 * -> asked for email -> called -> bought, with cost per visit, per call
 * request and per sale. Sample sizes are always shown, and no arm is called
 * ahead under 30 responses per arm.
 */
export const MIN_RESPONSES_PER_ARM = 30;

export interface ClinicRow {
  clinicId: string;
  channel: "letter" | "email";
  city: string;
  batch: string | null;
  arm: string | null;
  headline: string | null;
  contacted: boolean;
  delivered: boolean;
  visited: boolean;
  callRequested: boolean;
  emailAsked: boolean;
  called: boolean;
  bought: boolean;
  costUsd: number;
}

export interface Funnel {
  group: string;
  contacted: number;
  delivered: number;
  visited: number;
  callRequests: number;
  emailAsks: number;
  called: number;
  bought: number;
  costUsd: number;
  costPerVisit: number | null;
  costPerCallRequest: number | null;
  costPerSale: number | null;
}

export function funnel(group: string, rows: ClinicRow[]): Funnel {
  const n = (f: (r: ClinicRow) => boolean) => rows.filter(f).length;
  const cost = rows.reduce((s, r) => s + r.costUsd, 0);
  const per = (d: number) => (d > 0 ? Math.round((cost / d) * 100) / 100 : null);
  const visited = n((r) => r.visited), calls = n((r) => r.callRequested), bought = n((r) => r.bought);
  return {
    group, contacted: n((r) => r.contacted), delivered: n((r) => r.delivered), visited, callRequests: calls, emailAsks: n((r) => r.emailAsked),
    called: n((r) => r.called), bought, costUsd: Math.round(cost * 100) / 100,
    costPerVisit: per(visited), costPerCallRequest: per(calls), costPerSale: per(bought),
  };
}

export function groupBy(rows: ClinicRow[], key: (r: ClinicRow) => string | null): Funnel[] {
  const m = new Map<string, ClinicRow[]>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return [...m.entries()].map(([k, v]) => funnel(k, v)).sort((a, b) => a.group.localeCompare(b.group));
}

export interface Comparison {
  arms: Funnel[];
  /** null until every arm has at least 30 responses (visits) */
  ahead: string | null;
  note: string;
}

/** Compare arms on visit rate. Under 30 responses in any arm there is no "ahead" label. */
export function compare(arms: Funnel[]): Comparison {
  if (arms.length < 2) return { arms, ahead: null, note: "Needs two arms to compare." };
  const short = arms.filter((a) => a.visited < MIN_RESPONSES_PER_ARM);
  if (short.length) {
    return { arms, ahead: null, note: `Too few responses to compare: ${arms.map((a) => `${a.group} ${a.visited} of ${a.contacted}`).join(", ")}. Needs ${MIN_RESPONSES_PER_ARM} responses per arm.` };
  }
  const rate = (a: Funnel) => (a.contacted ? a.visited / a.contacted : 0);
  const best = [...arms].sort((a, b) => rate(b) - rate(a))[0];
  return { arms, ahead: best.group, note: `Higher visit rate so far: ${best.group} (${arms.map((a) => `${a.group} ${a.visited} of ${a.contacted}`).join(", ")}). This is an observation, not a proven difference.` };
}

export async function loadRows(): Promise<ClinicRow[]> {
  const sql = db();
  const rows = await sql<{
    clinic_id: string; channel: "letter" | "email"; city: string; batch: string | null; arm: string | null; headline: string | null;
    contacted: boolean; delivered: boolean; visited: boolean; call_requested: boolean; email_asked: boolean; called: boolean; bought: boolean; cost: number;
  }[]>`
    with first_mail as (
      select distinct on (p.clinic_id) p.clinic_id, p.mailed_at, p.returned_at, p.headline_variant, b.label
      from mail_pieces p join mail_batches b on b.id=p.batch_id
      where p.mailed_at is not null and not b.test_mode order by p.clinic_id, p.mailed_at),
    first_email as (
      select distinct on (clinic_id) clinic_id, sent_at, delivered_at, bounced_at from messages
      where status='sent' and not dry_run and type in ('first_email','follow_up') order by clinic_id, sent_at),
    base as (
      select c.id, ci.name as city, fm.mailed_at, fm.returned_at, fm.headline_variant, fm.label, fe.sent_at, fe.delivered_at, fe.bounced_at,
        case when fm.mailed_at is not null and (fe.sent_at is null or fm.mailed_at <= fe.sent_at) then 'letter' else 'email' end as channel
      from clinics c join cities ci on ci.id=c.city_id left join first_mail fm on fm.clinic_id=c.id left join first_email fe on fe.clinic_id=c.id
      where fm.mailed_at is not null or fe.sent_at is not null)
    select b.id as clinic_id, b.channel, b.city,
      case when b.channel='letter' then b.label end as batch,
      (select test_arm from routing_assignments a where a.clinic_id=b.id and a.test_arm is not null order by assigned_at limit 1) as arm,
      case when b.channel='letter' then b.headline_variant end as headline,
      true as contacted,
      case when b.channel='letter' then b.returned_at is null else (b.delivered_at is not null and b.bounced_at is null) end as delivered,
      exists (select 1 from page_visits v where v.clinic_id=b.id) as visited,
      exists (select 1 from call_requests q where q.clinic_id=b.id) as call_requested,
      exists (select 1 from email_consents e where e.clinic_id=b.id) as email_asked,
      exists (select 1 from call_requests q where q.clinic_id=b.id and q.status='called') as called,
      exists (select 1 from orders o where o.clinic_id=b.id and o.status='paid') as bought,
      (coalesce((select sum(cost_cents) from mail_pieces p join mail_batches mb on mb.id=p.batch_id where p.clinic_id=b.id and p.mailed_at is not null and not mb.test_mode), 0) / 100.0)::float as cost
    from base b`;
  return rows.map((r) => ({
    clinicId: r.clinic_id, channel: r.channel, city: r.city, batch: r.batch, arm: r.arm, headline: r.headline, contacted: r.contacted,
    delivered: r.delivered, visited: r.visited, callRequested: r.call_requested, emailAsked: r.email_asked, called: r.called, bought: r.bought, costUsd: r.cost,
  }));
}

export async function channelReport() {
  const rows = await loadRows();
  const letters = rows.filter((r) => r.channel === "letter");
  return {
    byChannel: groupBy(rows, (r) => r.channel),
    byBatch: groupBy(rows, (r) => r.batch),
    byCity: groupBy(rows, (r) => `${r.city} · ${r.channel}`),
    split: compare(groupBy(rows.filter((r) => r.arm), (r) => r.arm)),
    headline: compare(groupBy(letters.filter((r) => r.headline), (r) => `Headline ${r.headline}`)),
  };
}

/** The lists the owner works from. */
export async function channelLists() {
  const sql = db();
  const name = sql`coalesce(c.site_name, c.name) as clinic`;
  return {
    callRequests: await sql`
      select q.id, ${name}, k.contact_name, k.contact_role, k.phone, q.preferred_date, to_char(q.window_start,'HH24:MI') as window_start,
             to_char(q.window_end,'HH24:MI') as window_end, q.source_channel, q.created_at, k.expires_at
      from call_requests q join call_consents k on k.id=q.consent_id join clinics c on c.id=q.clinic_id
      where q.status='waiting' order by q.preferred_date, q.window_start`,
    visitedNoAction: await sql`
      select c.id, ${name}, count(v.*)::int as visits, max(v.at) as last_visit, (array_agg(v.source order by v.at))[1] as first_source
      from page_visits v join clinics c on c.id=v.clinic_id
      where not exists (select 1 from call_requests q where q.clinic_id=c.id) and not exists (select 1 from email_consents e where e.clinic_id=c.id)
        and not exists (select 1 from orders o where o.clinic_id=c.id and o.status='paid') and c.opted_out_at is null
      group by c.id order by max(v.at) desc limit 200`,
    returned: await sql`
      select p.id, ${name}, p.address_text, p.returned_at, p.status_reason from mail_pieces p join clinics c on c.id=p.clinic_id
      where p.status='returned' order by p.returned_at desc limit 200`,
    optouts: await sql`select o.id, ${name}, o.channel, o.source, o.created_at from optouts o left join clinics c on c.id=o.clinic_id order by o.created_at desc limit 200`,
    skipped: await sql`
      select distinct on (a.clinic_id) a.clinic_id, ${name}, a.reason, a.assigned_at from routing_assignments a join clinics c on c.id=a.clinic_id
      where a.channel='skipped' order by a.clinic_id, a.assigned_at desc`,
  };
}
