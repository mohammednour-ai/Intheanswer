import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { randomToken } from "@/lib/tokens";
import { requireOwner } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { renderLiveReviewTable } from "@/lib/reviews/liveTable";
import { levelLabel } from "@/lib/reviews/thresholds";
import { SITE_CHECK_LABELS, A11Y_LABEL } from "@/lib/sitetest/types";
import type { Evidence } from "@/lib/pipeline/audit/types";

async function createConnectLink(clinicId: string) {
  "use server";
  await requireOwner();
  await db()`insert into gbp_connections (clinic_id, connect_token) values (${clinicId}, ${randomToken(18)})
             on conflict (clinic_id) do update set connect_token=excluded.connect_token, status='pending'`;
  revalidatePath(`/portal/clinic/${clinicId}`);
}

const RESULT: Record<string, { t: string; cls: string }> = {
  pass: { t: "Pass", cls: "pill-ok" },
  needs_work: { t: "Needs work", cls: "pill-warn" },
  could_not_test: { t: "Could not test", cls: "" },
};

function EvidenceList({ ev }: { ev: Evidence[] }) {
  if (!ev?.length) return null;
  return (
    <ul className="small muted" style={{ margin: "4px 0 0", paddingLeft: 18, wordBreak: "break-word" }}>
      {ev.slice(0, 6).map((e, i) => (
        <li key={i}>
          {e.label ? <>{e.label} </> : null}
          {e.quote ? <q>{e.quote.slice(0, 200)}</q> : null}{" "}
          {e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.url}</a> : null}
        </li>
      ))}
    </ul>
  );
}

export default async function ClinicView(props: PageProps<"/portal/clinic/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const tab = sp.tab === "site" ? "site" : "reviews";
  const sql = db();
  const [c] = await sql`
    select c.*, coalesce(c.site_name, c.name) as display, ci.name as city from clinics c join cities ci on ci.id=c.city_id where c.id=${id}`;
  if (!c) notFound();

  let body: React.ReactNode;
  if (tab === "site") {
    const [run] = await sql`select * from site_test_runs where clinic_id=${id} order by started_at desc limit 1`;
    const checks = run
      ? await sql`select * from site_test_checks where run_id=${run.id}
                  order by case result when 'needs_work' then 0 when 'pass' then 1 else 2 end, impact desc`
      : [];
    body = !run ? <p className="muted">No site test yet.</p> : (
      <>
        <p className="small muted">
          Run {run.run_label as string}: {run.status as string}, {run.pages_crawled as number} pages (cap {run.page_cap as number}), speed source {(run.perf_source as string) ?? "none"}.
          Accessibility results are {A11Y_LABEL}. &ldquo;Could not test&rdquo; is never reported as a problem.
          {run.error ? ` Notes: ${run.error}` : ""}
        </p>
        <ul style={{ listStyle: "none", padding: 0 }} className="stack">
          {checks.map((k) => (
            <li key={String(k.id)} className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{SITE_CHECK_LABELS[k.check_key as string] ?? (k.check_key as string)}</strong>
                <span className={`pill ${RESULT[k.result as string].cls}`}>{RESULT[k.result as string].t}</span>
              </div>
              <div>{k.line as string}</div>
              <EvidenceList ev={k.evidence as Evidence[]} />
            </li>
          ))}
        </ul>
      </>
    );
  } else {
    const [snap] = await sql`select * from review_snapshots where clinic_id=${id} order by created_at desc limit 1`;
    const themes = snap ? await sql`select * from review_themes where snapshot_id=${snap.id} order by kind, mentions desc` : [];
    const [conn] = await sql`select * from gbp_connections where clinic_id=${id}`;
    const named = await sql<{ name: string }[]>`
      select distinct jsonb_array_elements(a.clinics_named)->>'name' as name
      from test_answers a join scores s on s.test_run_id=a.test_run_id where s.clinic_id=${id}`;
    const live = await renderLiveReviewTable({ clinicId: id, clinicName: c.display as string, clinicPlaceId: (c.place_id as string) ?? null, cityId: c.city_id as number, competitorNames: named.map((n) => n.name) }).catch(() => "");
    body = (
      <div className="stack">
        <section className="card">
          <h2 style={{ fontSize: "1.1rem" }}>Google Business Profile (own reviews)</h2>
          {snap ? (
            <>
              <p>{snap.total_count as number} reviews · average {String(snap.average_rating ?? "n/a")} · {String(snap.count_90d ?? "n/a")} in the last 90 days · owner replies {snap.reply_rate == null ? "n/a" : `${Math.round((snap.reply_rate as number) * 100)}%`} · {levelLabel(snap.analysis_level as never)}</p>
              <ul className="small">{themes.map((t) => <li key={String(t.id)}>{t.kind as string}: {t.theme as string} ({t.mentions as number})</li>)}</ul>
              <p className="small muted">Evidence: numbers computed from the reviews returned by the Business Profile API on {new Date(snap.created_at as Date).toLocaleDateString("en-CA")}; review text is not stored.</p>
            </>
          ) : <p className="muted">Not connected. Monthly clients connect their own profile to get the 90-day count, reply rate and review themes.</p>}
          {conn?.status === "connected" ? <p className="pill pill-ok">Connected: {conn.location_name as string}</p> : (
            <form action={createConnectLink.bind(null, id)} className="row">
              <button className="btn">{conn ? "New connect link" : "Create connect link for the clinic"}</button>
              {conn ? <code className="small">{`${env().APP_URL}/connect/google/${conn.connect_token}`}</code> : null}
            </form>
          )}
        </section>
        <section className="card">
          <h2 style={{ fontSize: "1.1rem" }}>Live comparison (Google Maps, not stored)</h2>
          {live ? <div dangerouslySetInnerHTML={{ __html: live }} /> : <p className="muted">Live ratings are not available (Places API key not set, place not matched, or the daily spend cap was reached).</p>}
        </section>
      </div>
    );
  }

  return (
    <article className="stack">
      <h1 style={{ marginBottom: 0 }}>{c.display as string}</h1>
      <p className="small muted">{c.city as string} · {c.domain as string} · status {String(c.status).replaceAll("_", " ")}</p>
      <nav className="row" aria-label="Clinic sections">
        <Link className={`btn ${tab === "reviews" ? "btn-primary" : ""}`} href={`/portal/clinic/${id}?tab=reviews`}>Reviews</Link>
        <Link className={`btn ${tab === "site" ? "btn-primary" : ""}`} href={`/portal/clinic/${id}?tab=site`}>Site test</Link>
        <Link className="btn" href={`/portal/pages`}>Pages</Link>
      </nav>
      {body}
    </article>
  );
}
