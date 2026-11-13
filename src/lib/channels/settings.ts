import { db } from "../db";
import { localDate } from "../time";

/**
 * Channel settings. No channel logic is hard-coded: on/off, pause-until, caps,
 * mode and routing rules are all read from channel_settings, and every change
 * is written to settings_audit_log with who and when.
 */
export const CHANNELS = ["email", "letter", "inbound", "call_me", "reply_consent"] as const;
export type Channel = (typeof CHANNELS)[number];
export const OUTBOUND: Channel[] = ["email", "letter", "call_me", "reply_consent"];

export const CHANNEL_LABELS: Record<Channel, string> = {
  email: "Email",
  letter: "Letter",
  inbound: "Inbound calls",
  call_me: "Call-me requests",
  reply_consent: "Replies by consent",
};

export interface ChannelValues {
  on: boolean;
  pause_until: string | null; // YYYY-MM-DD: paused through this date
  daily_cap: number;
  monthly_spend_cap_usd: number;
  mode: "REVIEW" | "AUTO";
  [extra: string]: unknown;
}

export interface LetterValues extends ChannelValues {
  cost_letter_cents: number;
  cost_postcard_cents: number;
  color: boolean;
  mailing_class: string;
  address_placement: "top_first_page" | "insert_blank_page";
  first_batch_max: number;
  followup_days: number;
  max_pieces: number;
  headline_test: boolean;
}

export interface RoutingRules {
  score_threshold: number;
  split_on: boolean;
  split_letter_pct: number;
  cooldown_days: number;
}

export const MIN_COOLDOWN_DAYS = 14;

export async function getChannel<T extends ChannelValues = ChannelValues>(channel: Channel): Promise<T> {
  const [r] = await db()<{ values: T }[]>`select values from channel_settings where channel=${channel}`;
  if (!r) throw new Error(`no settings for channel ${channel}`);
  return r.values;
}

export async function getRouting(): Promise<RoutingRules> {
  const [r] = await db()<{ values: RoutingRules }[]>`select values from channel_settings where channel='routing'`;
  return r.values;
}

export function validateChannel(channel: Channel, v: ChannelValues): ChannelValues {
  const out = { ...v };
  if (channel === "letter") out.mode = "REVIEW"; // letters are locked to REVIEW
  if (out.mode !== "REVIEW" && out.mode !== "AUTO") throw new Error("mode must be REVIEW or AUTO");
  if (!Number.isFinite(out.daily_cap) || out.daily_cap < 0) throw new Error("daily cap must be 0 or more");
  if (!Number.isFinite(out.monthly_spend_cap_usd) || out.monthly_spend_cap_usd < 0) throw new Error("monthly spend cap must be 0 or more");
  if (out.pause_until && !/^\d{4}-\d{2}-\d{2}$/.test(out.pause_until)) throw new Error("pause-until must be a date");
  return out;
}

export function validateRouting(r: RoutingRules): RoutingRules {
  if (!Number.isFinite(r.score_threshold) || r.score_threshold < 0) throw new Error("score threshold must be 0 or more");
  if (!(r.split_letter_pct >= 0 && r.split_letter_pct <= 100)) throw new Error("split must be between 0 and 100");
  if (!Number.isFinite(r.cooldown_days) || r.cooldown_days < MIN_COOLDOWN_DAYS) throw new Error(`cool-down must be at least ${MIN_COOLDOWN_DAYS} days`);
  return { score_threshold: r.score_threshold, split_on: !!r.split_on, split_letter_pct: r.split_letter_pct, cooldown_days: Math.round(r.cooldown_days) };
}

export async function audit(scope: string, actor: string, before: unknown, after: unknown) {
  const sql = db();
  await sql`insert into settings_audit_log (scope, actor, before, after)
            values (${scope}, ${actor}, ${before === undefined ? null : sql.json(before as never)}, ${after === undefined ? null : sql.json(after as never)})`;
}

export async function saveChannel(channel: Channel, patch: Partial<ChannelValues>, actor: string) {
  const before = await getChannel(channel);
  const after = validateChannel(channel, { ...before, ...patch } as ChannelValues);
  const sql = db();
  await sql`update channel_settings set values=${sql.json(after as never)}, updated_by=${actor}, updated_at=now() where channel=${channel}`;
  await audit(`channel:${channel}`, actor, before, after);
  return after;
}

export async function saveRouting(rules: RoutingRules, actor: string) {
  const before = await getRouting();
  const after = validateRouting(rules);
  const sql = db();
  await sql`update channel_settings set values=${sql.json(after as never)}, updated_by=${actor}, updated_at=now() where channel='routing'`;
  await audit("routing", actor, before, after);
  return after;
}

export async function setKillSwitch(on: boolean, actor: string) {
  const sql = db();
  const [b] = await sql<{ kill_switch: boolean }[]>`select kill_switch from app_settings where id`;
  await sql`update app_settings set kill_switch=${on}, updated_at=now() where id`;
  await audit("kill_switch", actor, { on: b.kill_switch }, { on });
}

/** What a channel has used today and this month (Toronto time). */
export async function channelUsage(channel: Channel): Promise<{ today: number; monthUsd: number }> {
  const sql = db();
  const today = localDate(new Date());
  const month = today.slice(0, 7);
  if (channel === "letter") {
    const [r] = await sql<{ today: number; cents: number }[]>`
      select count(*) filter (where (mailed_at at time zone 'America/Toronto')::date = ${today}::date)::int as today,
             coalesce(sum(cost_cents) filter (where to_char(mailed_at at time zone 'America/Toronto', 'YYYY-MM') = ${month}), 0)::int as cents
      from mail_pieces where mailed_at is not null`;
    return { today: r.today, monthUsd: r.cents / 100 };
  }
  if (channel === "email") {
    const [r] = await sql<{ today: number }[]>`
      select count(*)::int as today from messages where status='sent' and type in ('first_email','follow_up')
        and (sent_at at time zone 'America/Toronto')::date = ${today}::date`;
    const [c] = await sql<{ usd: number | null }[]>`
      select sum(cost_usd)::float as usd from cost_records where provider in ('ses','resend','email')
        and to_char(at at time zone 'America/Toronto', 'YYYY-MM') = ${month}`;
    return { today: r.today, monthUsd: c.usd ?? 0 };
  }
  if (channel === "call_me") {
    const [r] = await sql<{ today: number }[]>`
      select count(*)::int as today from call_requests where status in ('called','no_answer')
        and (handled_at at time zone 'America/Toronto')::date = ${today}::date`;
    const [c] = await sql<{ usd: number | null }[]>`
      select sum(cost_usd)::float as usd from cost_records where provider='voice' and to_char(at at time zone 'America/Toronto', 'YYYY-MM') = ${month}`;
    return { today: r.today, monthUsd: c.usd ?? 0 };
  }
  return { today: 0, monthUsd: 0 };
}

export interface ChannelGate {
  open: boolean;
  reason: string;
}

/**
 * The one check every outbound action goes through. Closed when: the kill
 * switch is on, the channel is off, it is paused, or a cap has been reached.
 * `addUsd` is the cost of what is about to be sent.
 */
export async function channelOpen(channel: Channel, addUsd = 0, now = new Date()): Promise<ChannelGate> {
  const sql = db();
  const [s] = await sql<{ kill_switch: boolean }[]>`select kill_switch from app_settings where id`;
  if (s.kill_switch && channel !== "inbound") return { open: false, reason: "kill switch is on" };
  const v = await getChannel(channel);
  if (!v.on) return { open: false, reason: `${CHANNEL_LABELS[channel]} is switched off` };
  if (v.pause_until && localDate(now) <= v.pause_until) return { open: false, reason: `${CHANNEL_LABELS[channel]} is paused until ${v.pause_until}` };
  const u = await channelUsage(channel);
  if (u.today >= v.daily_cap) return { open: false, reason: `daily cap of ${v.daily_cap} reached` };
  if (u.monthUsd + addUsd > v.monthly_spend_cap_usd) return { open: false, reason: `monthly spend cap of ${v.monthly_spend_cap_usd} USD reached` };
  return { open: true, reason: "open" };
}
