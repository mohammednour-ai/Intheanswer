import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { outreachResults, PERIODS, type Period, type ResultRow } from "@/lib/portal/results";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LABEL: Record<Period, string> = { day: "By day", week: "By week", month: "By month" };

function periodLabel(start: string, by: Period): string {
  const [y, m, d] = start.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (by === "month") return `${MONTHS[m - 1]} ${y}`;
  if (by === "week") return `Week of ${d} ${MONTHS[m - 1]}`;
  return `${DAYS[date.getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)}%` : "n/a");
const empty = (r: ResultRow) => !(r.emails || r.bounced || r.replies || r.viewers || r.calls || r.letters || r.purchases);

export default async function ResultsPage({ searchParams }: PageProps<"/portal/results">) {
  await requireOwner();
  const q = (await searchParams).by;
  const by: Period = PERIODS.includes(q as Period) ? (q as Period) : "day";
  const { rows, totals: t, firstEmails } = await outreachResults(by);
  // drop the empty periods before the first activity
  let last = rows.length;
  while (last > 0 && empty(rows[last - 1])) last--;
  const shown = rows.slice(0, last);

  return (
    <section className="stack">
      <h1>Results</h1>
      <p className="muted small">What went out and what came back. Your own visits, test calls and dry runs are not counted.</p>

      <div className="row">
        <div className="card">
          <div className="small muted">First emails sent</div>
          <strong>{firstEmails}</strong>
          <div className="small muted">{t.bounced} bounced ({pct(t.bounced, t.emails)})</div>
        </div>
        <div className="card">
          <div className="small muted">Replies</div>
          <strong>{t.replies}</strong>
          <div className="small muted">
            {pct(t.replies, firstEmails)} of first emails · {t.positive} interested or asking · {t.negative} no or remove
          </div>
        </div>
        <div className="card">
          <div className="small muted">Clinics that opened their report</div>
          <strong>{t.viewers}</strong>
          <div className="small muted">{t.returning} came back on another day</div>
        </div>
        <div className="card">
          <div className="small muted">Calls · letters · purchases</div>
          <strong>
            {t.calls} · {t.letters} · {t.purchases}
          </strong>
        </div>
      </div>

      <nav className="row" aria-label="Period">
        {PERIODS.map((p) => (
          <Link key={p} href={`/portal/results?by=${p}`} className={p === by ? "btn btn-primary" : "btn"} aria-current={p === by ? "page" : undefined}>
            {LABEL[p]}
          </Link>
        ))}
      </nav>

      {shown.length === 0 ? (
        <p className="muted">Nothing has gone out yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{by === "day" ? "Day" : by === "week" ? "Week" : "Month"}</th>
                <th>Emails sent</th>
                <th>Bounced</th>
                <th>Replies</th>
                <th>Interested or asking</th>
                <th>No or remove</th>
                <th>Opened report</th>
                <th>Came back</th>
                <th>Calls</th>
                <th>Letters</th>
                <th>Purchases</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.start} className={empty(r) ? "muted" : undefined}>
                  <td>{periodLabel(r.start, by)}</td>
                  <td>{r.emails}</td>
                  <td>{r.bounced}</td>
                  <td>{r.replies}</td>
                  <td>{r.positive}</td>
                  <td>{r.negative}</td>
                  <td>{r.viewers}</td>
                  <td>{r.returning}</td>
                  <td>{r.calls}</td>
                  <td>{r.letters}</td>
                  <td>{r.purchases}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="small muted stack">
        <p>
          <b>Emails sent</b> counts first emails and follow-ups. <b>Replies</b> leaves out automatic replies (out of office). Open the
          Replies tab to read them.
        </p>
        <p>
          <b>Opened report</b> counts clinics whose report was opened by a person. Many email systems open every link the moment an
          email arrives, to check it for safety, so an open in the first 2 minutes after sending is not counted. <b>Came back</b> is the
          stronger sign: the same clinic opened its report again on a later day.
        </p>
        <p>
          <b>Calls</b> are calls with a clinic that were answered, in either direction, not counting your own test numbers.{" "}
          <b>Letters</b> are real letters posted. <b>Purchases</b> are paid orders.
        </p>
      </div>
    </section>
  );
}
