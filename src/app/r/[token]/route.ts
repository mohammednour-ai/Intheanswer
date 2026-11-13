import { type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { currentOwner } from "@/lib/auth";
import { sha256 } from "@/lib/tokens";
import { LIVE_REVIEWS_MARKER, renderLiveReviewTable } from "@/lib/reviews/liveTable";

import { isAutomatedFetch } from "@/lib/site/viewers";

/**
 * Private report page at an unguessable URL. A view is counted when a person
 * opens it: not the owner, not a link scanner, crawler or prefetch, and at
 * most once per browser per hour. Unverified drafts are only visible to the
 * owner.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/r/[token]">) {
  const { token } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return new Response("Not found", { status: 404 });
  const sql = db();
  const [r] = await sql<{ id: string; html: string; data: { verified?: boolean; rows?: { namedInstead: string[] }[]; clinic?: { name: string } }; superseded: boolean; clinic_id: string | null; place_id: string | null; city_id: number | null }[]>`
    select r.id, r.html, r.data, r.superseded, r.clinic_id, c.place_id, c.city_id
    from reports r left join clinics c on c.id = r.clinic_id where r.token=${token}`;
  if (!r) return new Response("Not found", { status: 404 });
  // The owner is recognised with or without ?preview=owner (a signed-in owner
  // opening the plain link must not count as the clinic reading its report).
  // Only looked up when the request carries cookies, so a clinic's view costs nothing extra.
  const mayBeOwner = req.nextUrl.searchParams.get("preview") === "owner" || req.cookies.getAll().length > 0;
  const owner = mayBeOwner ? await currentOwner().catch(() => null) : null;
  if (!owner && r.data?.verified === false) return new Response("Not found", { status: 404 });
  const ua = req.headers.get("user-agent") ?? "";
  if (!owner && !isAutomatedFetch(ua, req.headers)) {
    // One view per report and browser per hour: a reload or a mail client that
    // opens the link twice is one reading, not several.
    const uaHash = sha256(ua).slice(0, 16);
    const counted = await sql`
      insert into report_views (report_id, ua_hash)
      select ${r.id}, ${uaHash}
      where not exists (
        select 1 from report_views where report_id=${r.id} and ua_hash=${uaHash} and viewed_at > now() - interval '1 hour')
      returning id`;
    if (counted.length) {
      await sql`update reports set view_count = view_count + 1, last_viewed_at = now(),
                first_viewed_at = coalesce(first_viewed_at, now()) where id=${r.id}`;
    }
  }
  // Live Google Maps ratings: fetched now, shown on the web page only, never stored.
  let html = r.html;
  if (html.includes(LIVE_REVIEWS_MARKER)) {
    let table = "";
    // capped per report per day, so a report URL cannot be used to run up Places cost
    const [slot] = await sql<{ ok: boolean }[]>`
      update reports set live_fetch_day = current_date,
        live_fetch_count = case when live_fetch_day = current_date then live_fetch_count + 1 else 1 end
      where id=${r.id} and (live_fetch_day is distinct from current_date
        or live_fetch_count < (select live_reviews_per_report_per_day from app_settings where id))
      returning true as ok`;
    if (slot?.ok && r.clinic_id && r.city_id) {
      const names = [...new Set((r.data.rows ?? []).flatMap((row) => row.namedInstead))].slice(0, 6);
      table = await renderLiveReviewTable({
        clinicId: r.clinic_id, clinicName: r.data.clinic?.name ?? "Your clinic", clinicPlaceId: r.place_id, cityId: r.city_id, competitorNames: names,
      }).catch(() => "");
    }
    html = html.replace(LIVE_REVIEWS_MARKER, table);
  }
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
