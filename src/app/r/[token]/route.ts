import { type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { currentOwner } from "@/lib/auth";
import { sha256 } from "@/lib/tokens";
import { LIVE_REVIEWS_MARKER, renderLiveReviewTable } from "@/lib/reviews/liveTable";

/**
 * Private report page at an unguessable URL. Views are counted unless the
 * owner is previewing. Unverified drafts are only visible to the owner.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/r/[token]">) {
  const { token } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return new Response("Not found", { status: 404 });
  const sql = db();
  const [r] = await sql<{ id: string; html: string; data: { verified?: boolean; rows?: { namedInstead: string[] }[]; clinic?: { name: string } }; superseded: boolean; clinic_id: string | null; place_id: string | null; city_id: number | null }[]>`
    select r.id, r.html, r.data, r.superseded, r.clinic_id, c.place_id, c.city_id
    from reports r left join clinics c on c.id = r.clinic_id where r.token=${token}`;
  if (!r) return new Response("Not found", { status: 404 });
  const owner = req.nextUrl.searchParams.get("preview") === "owner" ? await currentOwner() : null;
  if (!owner && r.data?.verified === false) return new Response("Not found", { status: 404 });
  if (!owner) {
    await sql`insert into report_views (report_id, ua_hash) values (${r.id}, ${sha256(req.headers.get("user-agent") ?? "").slice(0, 16)})`;
    await sql`update reports set view_count = view_count + 1, last_viewed_at = now(),
              first_viewed_at = coalesce(first_viewed_at, now()) where id=${r.id}`;
  }
  // Live Google Maps ratings: fetched now, shown on the web page only, never stored.
  let html = r.html;
  if (html.includes(LIVE_REVIEWS_MARKER)) {
    let table = "";
    if (r.clinic_id && r.city_id) {
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
