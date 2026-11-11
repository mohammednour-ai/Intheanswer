import { db } from "../db";
import type { Evidence } from "../pipeline/audit/types";

/**
 * Send priority, from data the pipeline has already stored (no extra lookups):
 *   +2 strong reviews and not recommended
 *   +3 weak website (site test)
 *   +2 fewer than 30 reviews
 *   +1 conflicting hours or name
 *   +1 public email on its own site
 * Order only: nothing here excludes a clinic. Chains and do-not-solicit
 * clinics never reach this point.
 *
 * Review points use stored review numbers, which exist only for a clinic that
 * connected its own Business Profile. Google Maps ratings are never stored
 * (Maps Platform terms), so for other clinics those two lines are "not
 * available" and score 0.
 */
export interface PriorityInput {
  recommended: number;
  total: number;
  reviews: { total: number; average: number | null } | null;
  site: { key: string; result: string; labOnly: boolean }[] | null;
  hoursConflict: boolean;
  nameConflict: boolean;
  emailOnOwnSite: boolean;
}

export interface PriorityLine {
  key: string;
  label: string;
  points: number;
  max: number;
  available: boolean;
  why: string;
}

const HIGH_IMPACT = new Set(["booking_path", "mobile_layout", "https", "crawl_real_text"]);

/** Weak website: three or more checks need work, or any one that stops a patient (booking, phone layout, HTTPS, unreadable text). */
export function weakWebsite(site: NonNullable<PriorityInput["site"]>): { weak: boolean; why: string } {
  const bad = site.filter((c) => c.result === "needs_work" && !c.labOnly);
  const high = bad.filter((c) => HIGH_IMPACT.has(c.key));
  if (high.length) return { weak: true, why: `needs work: ${high.map((c) => c.key).join(", ")}` };
  if (bad.length >= 3) return { weak: true, why: `${bad.length} site checks need work` };
  return { weak: false, why: `${bad.length} site check(s) need work` };
}

export function computePriority(i: PriorityInput): { score: number; lines: PriorityLine[] } {
  const notRecommended = i.total > 0 && i.recommended * 2 <= i.total; // recommended in half the questions or fewer
  const lines: PriorityLine[] = [];
  const strong = !!i.reviews && i.reviews.total >= 30 && (i.reviews.average ?? 0) >= 4.5;
  lines.push({
    key: "strong_reviews_not_recommended", label: "Strong reviews and not recommended", max: 2, available: !!i.reviews,
    points: strong && notRecommended ? 2 : 0,
    why: !i.reviews ? "review numbers not available (not stored for clinics that have not connected their profile)"
      : `${i.reviews.total} reviews, average ${i.reviews.average ?? "n/a"}; recommended in ${i.recommended} of ${i.total}`,
  });
  const w = i.site ? weakWebsite(i.site) : null;
  lines.push({ key: "weak_website", label: "Weak website (site test)", max: 3, available: !!i.site, points: w?.weak ? 3 : 0, why: w ? w.why : "site test not available" });
  lines.push({
    key: "few_reviews", label: "Fewer than 30 reviews", max: 2, available: !!i.reviews,
    points: i.reviews && i.reviews.total < 30 ? 2 : 0,
    why: i.reviews ? `${i.reviews.total} reviews` : "review numbers not available",
  });
  lines.push({
    key: "conflict", label: "Conflicting hours or name", max: 1, available: true,
    points: i.hoursConflict || i.nameConflict ? 1 : 0,
    why: [i.hoursConflict ? "two sets of hours on the site" : "", i.nameConflict ? "name differs on a directory" : ""].filter(Boolean).join("; ") || "none found",
  });
  lines.push({ key: "own_site_email", label: "Public email on its own site", max: 1, available: true, points: i.emailOnOwnSite ? 1 : 0, why: i.emailOnOwnSite ? "published on the clinic's site" : "not published on the clinic's site" });
  return { score: lines.reduce((s, l) => s + l.points, 0), lines };
}

/** Compute from stored rows and save on the clinic. Called by the scoring step. */
export async function updateClinicPriority(clinicId: string, auditId: string, recommended: number, total: number) {
  const sql = db();
  const [snap] = await sql<{ total_count: number; average_rating: number | null }[]>`
    select total_count, average_rating from review_snapshots where clinic_id=${clinicId} order by created_at desc limit 1`;
  const [run] = await sql<{ id: string }[]>`select id from site_test_runs where clinic_id=${clinicId} and status='done' order by finished_at desc limit 1`;
  const site = run
    ? (await sql<{ check_key: string; result: string; metrics: { source?: string } }[]>`select check_key, result::text, metrics from site_test_checks where run_id=${run.id}`)
        .map((r) => ({ key: r.check_key, result: r.result, labOnly: r.check_key.startsWith("speed_") && r.metrics?.source !== "pagespeed" }))
    : null;
  const checks = await sql<{ check_key: string; result: string; is_gap: boolean; evidence: Evidence[] }[]>`
    select check_key, result::text, is_gap, evidence from audit_checks where audit_id=${auditId} and check_key in ('hours_conflict','directory_consistency')`;
  const hoursConflict = checks.some((c) => c.check_key === "hours_conflict" && c.result === "found" && c.is_gap);
  const nameConflict = checks.some((c) => c.check_key === "directory_consistency" && c.result === "found" && c.evidence.some((e) => (e.label ?? "").startsWith("name:")));
  const [contact] = await sql<{ source_url: string; domain: string | null }[]>`
    select k.source_url, c.domain from contacts k join clinics c on c.id=k.clinic_id where k.clinic_id=${clinicId} and k.is_primary limit 1`;
  let emailOnOwnSite = false;
  try {
    const h = new URL(contact?.source_url ?? "").hostname.replace(/^www\./, "");
    emailOnOwnSite = !!contact?.domain && (h === contact.domain || h.endsWith("." + contact.domain));
  } catch {
    emailOnOwnSite = false;
  }
  const p = computePriority({
    recommended, total,
    reviews: snap ? { total: snap.total_count, average: snap.average_rating } : null,
    site, hoursConflict, nameConflict, emailOnOwnSite,
  });
  await sql`update clinics set priority_score=${p.score}, priority_breakdown=${sql.json(p.lines as never)} where id=${clinicId}`;
  return p;
}

/**
 * The send order. Hand-ordered clinics first (highest manual value first),
 * then by score. A waiting item gains one point per full week, so a low score
 * is delayed, never dropped.
 */
export const ORDER_SQL = `
  (c.priority_manual is null), c.priority_manual desc nulls last,
  (coalesce(c.priority_score, 0) + floor(extract(epoch from (now() - m.created_at)) / 604800)) desc,
  m.created_at`;

/** Approved cold emails in the order the daily queue should take them. */
export async function nextToSend(limit: number) {
  return db().unsafe<{ id: string; clinic_id: string | null; priority_score: number }[]>(
    `select m.id, m.clinic_id, coalesce(c.priority_score, 0) as priority_score
     from messages m left join clinics c on c.id = m.clinic_id
     where m.status = 'approved' and m.type in ('first_email', 'follow_up')
     order by ${ORDER_SQL} limit $1`,
    [limit],
  );
}

/** Job priority for a clinic's send job: lower runs first. */
export async function sendJobPriority(clinicId: string | null): Promise<number> {
  if (!clinicId) return 50;
  const [c] = await db()<{ priority_score: number; priority_manual: number | null }[]>`select priority_score, priority_manual from clinics where id=${clinicId}`;
  if (!c) return 50;
  return c.priority_manual != null ? 10 : Math.max(20, 60 - c.priority_score * 4);
}

// ---------------------------------------------------------------------------
// Hand reordering of the review queue
// ---------------------------------------------------------------------------
async function currentOrder(): Promise<string[]> {
  const rows = await db().unsafe<{ clinic_id: string }[]>(
    `select m.clinic_id from messages m join clinics c on c.id = m.clinic_id
     where m.status in ('pending_review', 'approved') and m.clinic_id is not null
     order by ${ORDER_SQL}`,
  );
  return [...new Set(rows.map((r) => r.clinic_id))];
}

async function writeOrder(ids: string[]) {
  const sql = db();
  await sql.begin(async (tx) => {
    for (let i = 0; i < ids.length; i++) await tx`update clinics set priority_manual=${ids.length - i} where id=${ids[i]}`;
  });
  for (const id of ids) {
    const p = await sendJobPriority(id);
    await sql`update jobs set priority=${p} where status='queued' and kind='send_message'
              and payload->>'messageId' in (select id::text from messages where clinic_id=${id})`;
  }
}

export async function reorder(clinicId: string, move: "top" | "up" | "down" | "reset") {
  const sql = db();
  if (move === "reset") {
    await sql`update clinics set priority_manual=null where id=${clinicId}`;
    return;
  }
  const order = await currentOrder();
  const i = order.indexOf(clinicId);
  if (i < 0) return;
  if (move === "top") {
    const [m] = await sql<{ m: number | null }[]>`select max(priority_manual) as m from clinics`;
    await sql`update clinics set priority_manual=${(m.m ?? 0) + 1} where id=${clinicId}`;
    return;
  }
  const j = move === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  // Fix the order by hand down to the lowest row that is moved or already hand-ordered;
  // rows below that keep their score order.
  const manual = new Set((await sql<{ id: string }[]>`select id from clinics where priority_manual is not null`).map((r) => r.id));
  let last = Math.max(i, j);
  order.forEach((id, k) => {
    if (manual.has(id)) last = Math.max(last, k);
  });
  await writeOrder(order.slice(0, last + 1));
}
