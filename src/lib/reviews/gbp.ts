import { z } from "zod";
import { db } from "../db";
import { env } from "../env";
import { seal, open } from "../crypto";
import { structured } from "../adapters/claude";
import { analysisLevel, type AnalysisLevel } from "./thresholds";

/**
 * Google Business Profile, for monthly clients who connect their OWN profile.
 * Endpoints (Business Profile APIs; reviews list checked 2026-11-11):
 *   OAuth:     accounts.google.com/o/oauth2/v2/auth, oauth2.googleapis.com/token, scope business.manage
 *   Accounts:  mybusinessaccountmanagement.googleapis.com/v1/accounts
 *   Locations: mybusinessbusinessinformation.googleapis.com/v1/{account}/locations
 *   Reviews:   mybusiness.googleapis.com/v4/{accounts/*\/locations/*}/reviews  (pageSize <= 50)
 * Business Profile API access must be approved by Google for the project.
 * Review text is processed in memory only: never stored, never sent with
 * reviewer names; only numbers and short theme labels are kept.
 */

export const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";

export function redirectUri() {
  return `${env().APP_URL}/connect/google/callback`;
}

export function authUrl(connectToken: string): string {
  const id = env().GOOGLE_OAUTH_CLIENT_ID;
  if (!id) throw new Error("GOOGLE_OAUTH_CLIENT_ID is not set");
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", id);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GBP_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", connectToken);
  return u.toString();
}

async function token(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string }> {
  const e = env();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: e.GOOGLE_OAUTH_CLIENT_ID ?? "", client_secret: e.GOOGLE_OAUTH_CLIENT_SECRET ?? "", ...params }),
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  return res.json() as Promise<{ access_token: string; refresh_token?: string }>;
}

async function gget<T>(url: string, access: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${access}` } });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
  return res.json() as Promise<T>;
}

/** OAuth callback: store the refresh token (encrypted) and pick the location whose website matches the clinic. */
/** A location is the clinic's only when its website is on the clinic's own domain. */
export function locationMatchesDomain(websiteUri: string | undefined, domain: string | null): boolean {
  if (!websiteUri || !domain) return false;
  try {
    const h = new URL(websiteUri).hostname.toLowerCase().replace(/^www\./, "");
    return h === domain || h.endsWith("." + domain);
  } catch {
    return false;
  }
}

/** A connect link works for this long after it was created (or re-created) in the portal. */
export const CONNECT_LINK_DAYS = 14;

/** Give a token back to Google: we must not keep access we have no use for. Best effort. */
export async function revokeToken(tok: string): Promise<boolean> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tok }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Why a connect link cannot be used, or null when it can. */
export function connectLinkProblem(conn: { status: string; link_age_days: number } | undefined): string | null {
  if (!conn) return "unknown connection link";
  if (conn.status === "connected") return "this Business Profile is already connected; ask for a new link to connect again";
  if (conn.status === "revoked") return "this connection link is no longer valid";
  if (conn.link_age_days > CONNECT_LINK_DAYS) return `this connection link has expired (links are valid for ${CONNECT_LINK_DAYS} days); ask for a new one`;
  return null;
}

export async function completeConnection(connectToken: string, code: string): Promise<{ clinicId: string; location: string | null }> {
  const sql = db();
  const [conn] = await sql<{ clinic_id: string; domain: string | null; status: string; link_age_days: number }[]>`
    select g.clinic_id, c.domain, g.status, extract(epoch from (now() - g.link_created_at)) / 86400.0 as link_age_days
    from gbp_connections g join clinics c on c.id=g.clinic_id where g.connect_token=${connectToken}`;
  // An already connected row is never replaced through an old link, and a link does not live forever.
  const problem = connectLinkProblem(conn && { status: conn.status, link_age_days: Number(conn.link_age_days) });
  if (problem || !conn) throw new Error(problem ?? "unknown connection link");
  const t = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri() });
  if (!t.refresh_token) {
    await revokeToken(t.access_token);
    throw new Error("Google did not return a refresh token");
  }
  let location: string | null = null;
  try {
    const accounts = await gget<{ accounts?: { name: string }[] }>("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", t.access_token);
    for (const a of accounts.accounts ?? []) {
      const locs = await gget<{ locations?: { name: string; websiteUri?: string }[] }>(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title,websiteUri&pageSize=100`,
        t.access_token,
      );
      const match = (locs.locations ?? []).find((l) => locationMatchesDomain(l.websiteUri, conn.domain));
      if (match) {
        location = `${a.name}/${match.name}`; // accounts/{a}/locations/{l}
        break;
      }
    }
  } catch (e) {
    await revokeToken(t.refresh_token); // nothing was stored: do not leave a live grant behind
    throw e;
  }
  if (!location) {
    // The Google account that signed in does not manage this clinic's profile:
    // its token is given back to Google and never stored.
    const revoked = await revokeToken(t.refresh_token);
    await sql`update gbp_connections set refresh_token_enc=null, location_name=null, status='error', connected_at=null,
              last_error=${"no location on this Google account lists the clinic's website" + (revoked ? "" : " (the token could not be revoked at Google; it was not stored)")}
              where connect_token=${connectToken} and status <> 'connected'`;
    return { clinicId: conn.clinic_id, location: null };
  }
  const done = await sql`update gbp_connections set refresh_token_enc=${seal(t.refresh_token)}, location_name=${location},
            status='connected', connected_at=now(), last_error=null
            where connect_token=${connectToken} and status <> 'connected' returning clinic_id`;
  if (!done.length) {
    // Connected by a parallel request in the meantime. Not revoked here:
    // revoking would also end the grant the other request just stored.
    throw new Error("this Business Profile is already connected");
  }
  return { clinicId: conn.clinic_id, location };
}

export interface GbpReview {
  starRating: "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE" | "STAR_RATING_UNSPECIFIED";
  comment?: string;
  createTime: string;
  reviewReply?: { comment: string; updateTime: string };
}

export async function fetchOwnReviews(clinicId: string, max = 500): Promise<{ reviews: GbpReview[]; total: number; average: number | null }> {
  const sql = db();
  const [g] = await sql<{ refresh_token_enc: string | null; location_name: string | null }[]>`
    select refresh_token_enc, location_name from gbp_connections where clinic_id=${clinicId} and status='connected'`;
  if (!g?.refresh_token_enc || !g.location_name) throw new Error("Business Profile not connected");
  const t = await token({ grant_type: "refresh_token", refresh_token: open(g.refresh_token_enc) });
  const reviews: GbpReview[] = [];
  let total = 0;
  let average: number | null = null;
  let pageToken = "";
  do {
    const u = new URL(`https://mybusiness.googleapis.com/v4/${g.location_name}/reviews`);
    u.searchParams.set("pageSize", "50");
    u.searchParams.set("orderBy", "updateTime desc");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const j = await gget<{ reviews?: GbpReview[]; totalReviewCount?: number; averageRating?: number; nextPageToken?: string }>(u.toString(), t.access_token);
    reviews.push(...(j.reviews ?? []));
    total = j.totalReviewCount ?? total;
    average = j.averageRating ?? average;
    pageToken = j.nextPageToken ?? "";
  } while (pageToken && reviews.length < max);
  return { reviews, total, average };
}

const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, STAR_RATING_UNSPECIFIED: 0 } as const;

export interface ReviewMetrics {
  total: number;
  average: number | null;
  latest: string | null;
  count90d: number;
  replyRate: number | null;
  level: AnalysisLevel;
}

export function computeMetrics(reviews: GbpReview[], total: number, average: number | null, now = new Date()): ReviewMetrics {
  const cutoff = now.getTime() - 90 * 86400e3;
  const latest = reviews.reduce<string | null>((m, r) => (!m || r.createTime > m ? r.createTime : m), null);
  const count90d = reviews.filter((r) => new Date(r.createTime).getTime() >= cutoff).length;
  const replyRate = reviews.length ? Math.round((reviews.filter((r) => r.reviewReply?.comment).length / reviews.length) * 1000) / 1000 : null;
  const avg = average ?? (reviews.length ? Math.round((reviews.reduce((s, r) => s + STARS[r.starRating], 0) / reviews.length) * 100) / 100 : null);
  return { total: Math.max(total, reviews.length), average: avg, latest, count90d, replyRate, level: analysisLevel(Math.max(total, reviews.length)) };
}

// ---------------------------------------------------------------------------
const Themes = z.object({
  praise: z.array(z.object({ theme: z.string(), mentions: z.number().int() })),
  complaint: z.array(z.object({ theme: z.string(), mentions: z.number().int() })),
  service: z.array(z.object({ theme: z.string(), mentions: z.number().int() })),
});

/** Labels that could carry a health detail or a person are dropped even if the model returns them. */
const SENSITIVE = /\b(dr\.?|doctor [A-Z]|mr\.?|mrs\.?|ms\.?|diagnos|cancer|tumou?r|pregnan|miscarr|depress|anxiety|mental|hiv|std|sti|abortion|addict|overdose|suicid|disab|diabet|surgery on|my (son|daughter|husband|wife|mother|father))\b/i;

export function scrubThemes(t: z.infer<typeof Themes>) {
  const clean = (xs: { theme: string; mentions: number }[]) =>
    xs.filter((x) => x.theme.length <= 60 && !SENSITIVE.test(x.theme) && x.mentions > 0).slice(0, 8);
  return { praise: clean(t.praise), complaint: clean(t.complaint), service: clean(t.service) };
}

export async function analyseThemes(reviews: GbpReview[], level: AnalysisLevel) {
  if (level === "none") return null;
  const texts = reviews.filter((r) => r.comment && r.comment.trim().length > 15).slice(0, level === "full" ? 300 : 60);
  if (!texts.length) return null;
  const r = await structured({
    purpose: "review-themes",
    system: `You summarise patient reviews of the clinic that owns them into short theme labels with counts.
Rules: labels of 2 to 5 words about the clinic's service (for example "short wait times", "front desk friendliness", "billing questions").
Never include a person's name, a staff name, or any health condition, treatment outcome, diagnosis or personal detail. Count how many reviews mention each theme.
"service": which services patients mention (for example "cleanings", "implants", "walk-in visits").`,
    user: texts.map((t, i) => `<review n="${i + 1}" stars="${STARS[t.starRating]}">${(t.comment ?? "").slice(0, 1200)}</review>`).join("\n"),
    schema: Themes,
    effort: "low",
  });
  return { themes: scrubThemes(r.data), usage: r.usage, costUsd: r.costUsd, analysed: texts.length };
}

export async function storeSnapshot(clinicId: string, runLabel: string, m: ReviewMetrics, themes: ReturnType<typeof scrubThemes> | null, analysed: number) {
  const sql = db();
  return sql.begin(async (tx) => {
    const [s] = await tx<{ id: string }[]>`
      insert into review_snapshots (clinic_id, run_label, average_rating, total_count, latest_review_at, count_90d, reply_rate, analysis_level, analysed_count)
      values (${clinicId}, ${runLabel}, ${m.average}, ${m.total}, ${m.latest}, ${m.count90d}, ${m.replyRate}, ${m.level}, ${analysed})
      on conflict (clinic_id, run_label) do update set average_rating=excluded.average_rating, total_count=excluded.total_count,
        latest_review_at=excluded.latest_review_at, count_90d=excluded.count_90d, reply_rate=excluded.reply_rate,
        analysis_level=excluded.analysis_level, analysed_count=excluded.analysed_count
      returning id`;
    await tx`delete from review_themes where snapshot_id=${s.id}`;
    if (themes) {
      for (const kind of ["praise", "complaint", "service"] as const) {
        for (const t of themes[kind]) await tx`insert into review_themes (snapshot_id, kind, theme, mentions) values (${s.id}, ${kind}, ${t.theme}, ${t.mentions})`;
      }
    }
    return s.id;
  });
}

export interface SnapshotDiff {
  totalChange: number | null;
  averageChange: number | null;
  count90dChange: number | null;
  replyRateChange: number | null;
}

export function diffSnapshots(prev: { total_count: number; average_rating: number | null; count_90d: number | null; reply_rate: number | null } | null,
  cur: { total_count: number; average_rating: number | null; count_90d: number | null; reply_rate: number | null }): SnapshotDiff {
  if (!prev) return { totalChange: null, averageChange: null, count90dChange: null, replyRateChange: null };
  const d = (a: number | null, b: number | null) => (a == null || b == null ? null : Math.round((b - a) * 1000) / 1000);
  return {
    totalChange: cur.total_count - prev.total_count,
    averageChange: d(prev.average_rating, cur.average_rating),
    count90dChange: d(prev.count_90d, cur.count_90d),
    replyRateChange: d(prev.reply_rate, cur.reply_rate),
  };
}
