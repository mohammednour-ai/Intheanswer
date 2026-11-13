import { requireOwner } from "@/lib/auth";
import Link from "next/link";
import { db } from "@/lib/db";

const STATUS: Record<string, string> = {
  proposed: "Proposed", draft: "Draft", owner_reviewed: "Reviewed by you", sent_to_clinic: "Waiting for clinic",
  changes_requested: "Clinic asked for changes", clinic_approved: "Clinic approved", live: "Live", rejected: "Rejected",
};

export default async function PagesScreen() {
  await requireOwner();
  const rows = await db()`
    select p.id, p.title, p.status::text, p.kind, p.target_question, p.live_url, p.planned_month, p.latest_test_status::text,
           p.latest_test_at, coalesce(c.site_name, c.name) as clinic, c.id as clinic_id,
           (select max(version) from answer_page_versions v where v.page_id=p.id) as versions
    from answer_pages p join clinics c on c.id=p.clinic_id
    where p.status <> 'rejected' order by p.updated_at desc limit 300`;
  return (
    <section>
      <h1>Pages</h1>
      <p className="muted">Answer pages: draft, your review, clinic approval by link, published, then retested each month.</p>
      {rows.length === 0 ? <p className="muted">No pages proposed yet.</p> : (
        <ul style={{ listStyle: "none", padding: 0 }} className="stack">
          {rows.map((r) => (
            <li key={r.id as string}>
              <Link href={`/portal/pages/${r.id}`} className="card" style={{ display: "block", color: "inherit", textDecoration: "none" }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>{r.title as string}</strong>
                  <span className={`pill ${r.status === "live" ? "pill-ok" : r.status === "changes_requested" ? "pill-warn" : ""}`}>{STATUS[r.status as string]}</span>
                </div>
                <div className="small muted">{r.clinic as string} · {r.kind === "question" ? "question page" : "service page"}{r.planned_month ? ` · planned ${r.planned_month}` : ""}{r.versions ? ` · v${r.versions}` : ""}</div>
                <div className="small" style={{ marginTop: 4 }}>Target question: {r.target_question as string}</div>
                <div className="small muted">
                  {r.live_url ? <>Live: {r.live_url as string} · </> : null}
                  Latest test: {r.latest_test_status ? String(r.latest_test_status).replace("_", " ") : "not tested yet"}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
