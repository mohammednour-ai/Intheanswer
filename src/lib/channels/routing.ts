import crypto from "node:crypto";
import { db } from "../db";
import { getRouting, type RoutingRules } from "./settings";

/**
 * Routing: which clinic gets a letter and which gets email. Rules are read
 * from settings and applied in this order:
 *   1. Exclude chains, suppressed and opted-out clinics.
 *   2. Lead score threshold: score >= X gets a letter first, below X email first.
 *   3. No public email -> letter. No verified address -> email. Neither -> skipped and listed.
 *   4. Test split (when on): a random share of new clinics goes to each channel, ignoring rule 2.
 *   5. Cool-down: a clinic that did not respond may be tried on the other channel only after N days;
 *      never two channels inside the window.
 *   6. Contact by consent (call-me, reply, email asked for on the teaser page) is never routed here,
 *      so the cool-down never blocks it.
 *   7. One mail piece per clinic, not per person.
 */
export interface RouteFacts {
  clinicId: string;
  name: string;
  excluded: string | null; // chain | suppressed | opted out | ...
  score: number;
  hasEmail: boolean; // an address the clinic publishes on its own site
  hasAddress: boolean; // an address confirmed on its own site and not returned as bad
  engaged: boolean; // replied, visited-and-acted, bought
  /** earlier outbound contact, most recent first */
  history: { channel: "letter" | "email"; at: Date }[];
  mailPieces: number;
  storedArm: "letter" | "email" | null;
}

export interface Route {
  clinicId: string;
  name: string;
  channel: "letter" | "email" | "skipped" | "excluded" | "wait" | "done";
  rule: number;
  reason: string;
  arm: "letter" | "email" | null;
}

/** Deterministic per clinic, so a preview and the real assignment agree. */
export function splitArm(clinicId: string, letterPct: number): "letter" | "email" {
  const n = crypto.createHash("sha256").update("split:" + clinicId).digest().readUInt32BE(0) / 0xffffffff;
  return n * 100 < letterPct ? "letter" : "email";
}

export function route(f: RouteFacts, rules: RoutingRules, now = new Date(), maxPieces = 2): Route {
  const base = { clinicId: f.clinicId, name: f.name, arm: null as Route["arm"] };
  // 1
  if (f.excluded) return { ...base, channel: "excluded", rule: 1, reason: f.excluded };
  if (f.engaged) return { ...base, channel: "done", rule: 6, reason: "the clinic has engaged; further contact is by consent only" };

  const can = { letter: f.hasAddress && f.mailPieces < maxPieces, email: f.hasEmail };
  if (!f.hasAddress && !f.hasEmail) return { ...base, channel: "skipped", rule: 3, reason: "no address confirmed on its site and no public email" };

  // 5: already contacted
  if (f.history.length) {
    const last = f.history[0];
    const days = Math.floor((now.getTime() - last.at.getTime()) / 86400e3);
    const tried = new Set(f.history.map((h) => h.channel));
    const other = last.channel === "letter" ? "email" : "letter";
    if (days < rules.cooldown_days) return { ...base, channel: "wait", rule: 5, reason: `contacted by ${last.channel} ${days} day(s) ago; cool-down is ${rules.cooldown_days} days` };
    if (tried.has(other) || !can[other]) return { ...base, channel: "done", rule: 5, reason: tried.has(other) ? "both channels tried" : `other channel (${other}) not available` };
    return { ...base, channel: other, rule: 5, reason: `no response to ${last.channel} after ${days} days; trying ${other}` };
  }

  // 4 overrides 2
  let preferred: "letter" | "email";
  let rule: number;
  let reason: string;
  let arm: Route["arm"] = null;
  if (rules.split_on) {
    arm = f.storedArm ?? splitArm(f.clinicId, rules.split_letter_pct);
    preferred = arm;
    rule = 4;
    reason = `test split: assigned to ${arm}`;
  } else {
    preferred = f.score >= rules.score_threshold ? "letter" : "email";
    rule = 2;
    reason = `lead score ${f.score} ${f.score >= rules.score_threshold ? ">=" : "<"} ${rules.score_threshold}`;
  }
  // 3
  if (!can[preferred]) {
    const fallback = preferred === "letter" ? "email" : "letter";
    if (!can[fallback]) return { ...base, channel: "skipped", rule: 3, reason: "no usable channel (mail limit reached or no address, and no public email)" };
    return { ...base, arm, channel: fallback, rule: 3, reason: preferred === "letter" ? "no verified address: email" : "no public email: letter" };
  }
  return { ...base, arm, channel: preferred, rule, reason };
}

/** Facts for clinics that are ready for outreach (teaser verified, not yet handled), highest score first. */
export async function loadFacts(limit: number, cityId?: number): Promise<RouteFacts[]> {
  const sql = db();
  const rows = await sql<{
    id: string; name: string; status: string; opted_out_at: Date | null; priority_score: number; replied: boolean;
    has_email: boolean; has_address: boolean; suppressed: boolean; pieces: number; arm: string | null; bought: boolean; acted: boolean;
  }[]>`
    select c.id, coalesce(c.site_name, c.name) as name, c.status::text, c.opted_out_at, c.priority_score, c.replied,
      exists (select 1 from contacts k where k.clinic_id=c.id and k.is_primary) as has_email,
      (c.address_confirmed_on_site and c.address is not null and not c.address_bad) as has_address,
      exists (select 1 from contacts k join suppressions s on (s.kind='address' and s.value=lower(k.email)) or (s.kind='domain' and s.value=c.domain)
              where k.clinic_id=c.id) as suppressed,
      (select count(*)::int from mail_pieces p where p.clinic_id=c.id and p.mailed_at is not null) as pieces,
      (select test_arm from routing_assignments a where a.clinic_id=c.id and a.test_arm is not null order by assigned_at limit 1) as arm,
      exists (select 1 from orders o where o.clinic_id=c.id and o.status='paid') as bought,
      (exists (select 1 from call_requests q where q.clinic_id=c.id) or exists (select 1 from email_consents e where e.clinic_id=c.id)) as acted
    from clinics c
    where c.status in ('queued', 'teaser_built', 'contacted', 'suppressed', 'do_not_contact', 'excluded')
      and exists (select 1 from reports r where r.clinic_id=c.id and r.kind='teaser' and (r.data->>'verified')::boolean and not r.superseded)
      and (${cityId ?? null}::int is null or c.city_id = ${cityId ?? null})
    order by c.priority_manual desc nulls last, c.priority_score desc, c.created_at
    limit ${limit}`;
  const ids = rows.map((r) => r.id);
  const hist = ids.length
    ? await sql<{ clinic_id: string; channel: "letter" | "email"; at: Date }[]>`
        select clinic_id, 'letter' as channel, mailed_at as at from mail_pieces where clinic_id = any(${ids}) and mailed_at is not null
        union all
        select clinic_id, 'email', sent_at from messages where clinic_id = any(${ids}) and status='sent' and type in ('first_email','follow_up')
        order by at desc`
    : [];
  return rows.map((r) => ({
    clinicId: r.id,
    name: r.name,
    excluded:
      r.status === "excluded" ? "chain or no website of its own"
      : r.status === "do_not_contact" ? "its site says not to send solicitations"
      : r.opted_out_at ? "opted out"
      : r.status === "suppressed" || r.suppressed ? "suppressed"
      : null,
    score: r.priority_score,
    hasEmail: r.has_email,
    hasAddress: r.has_address,
    engaged: r.replied || r.bought || r.acted,
    history: hist.filter((h) => h.clinic_id === r.id),
    mailPieces: r.pieces,
    storedArm: (r.arm as "letter" | "email" | null) ?? null,
  }));
}

export interface Preview {
  rows: { name: string; current: Route; proposed: Route; changed: boolean }[];
  counts: { current: Record<string, number>; proposed: Record<string, number> };
  changed: number;
  total: number;
}

/** How the next N clinics would be routed under the proposed rules versus the current ones. */
export async function previewRouting(proposed: RoutingRules, n = 100): Promise<Preview> {
  const current = await getRouting();
  const facts = await loadFacts(n);
  const tally = (rs: Route[]) => rs.reduce<Record<string, number>>((m, r) => ((m[r.channel] = (m[r.channel] ?? 0) + 1), m), {});
  const cur = facts.map((f) => route(f, current));
  const prop = facts.map((f) => route(f, proposed));
  const rows = facts.map((f, i) => ({ name: f.name, current: cur[i], proposed: prop[i], changed: cur[i].channel !== prop[i].channel }));
  return { rows, counts: { current: tally(cur), proposed: tally(prop) }, changed: rows.filter((r) => r.changed).length, total: facts.length };
}

/** Route and record the assignment (with the test arm) for clinics about to be batched. */
export async function assign(facts: RouteFacts[], batchLabel: string): Promise<Route[]> {
  const sql = db();
  const rules = await getRouting();
  const [l] = await sql<{ values: { max_pieces?: number } }[]>`select values from channel_settings where channel='letter'`;
  const out: Route[] = [];
  for (const f of facts) {
    const r = route(f, rules, new Date(), l?.values.max_pieces ?? 2);
    out.push(r);
    if (r.channel === "letter" || r.channel === "email" || r.channel === "skipped") {
      await sql`insert into routing_assignments (clinic_id, channel, test_arm, rule, reason, batch_label)
                values (${f.clinicId}, ${r.channel}, ${r.arm}, ${r.rule}, ${r.reason}, ${batchLabel})`;
    }
  }
  return out;
}
