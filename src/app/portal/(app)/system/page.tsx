import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { systemStatus } from "@/lib/schedule/status";
import { retryJobAction, dismissAlertAction } from "./actions";

export const dynamic = "force-dynamic";

const usd = (n: number) => `$${n.toFixed(2)}`;
const date = (d: Date | null) => (d ? new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Toronto" }) : "never");
const dateTime = (d: Date | null) =>
  d ? new Date(d).toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" }) : "";
const short = (s: string | null, n = 220) => (s ?? "").slice(0, n);

function jobPill(status: string | null, none: string) {
  if (!status) return <span className="muted">{none}</span>;
  const cls = status === "done" ? "pill pill-ok" : status === "dead" ? "pill pill-bad" : status === "queued" || status === "running" ? "pill pill-blue" : "pill pill-warn";
  return <span className={cls}>{status}</span>;
}

export default async function SystemPage() {
  await requireOwner();
  const s = await systemStatus();
  const over = s.spendToday >= s.spendCap;
  return (
    <section className="stack">
      <h1>System</h1>

      <div className="row">
        <div className="card">
          <div className="small muted">API spend today</div>
          <strong>{usd(s.spendToday)}</strong> <span className="small muted">of {usd(s.spendCap)} cap</span>
          {over ? <div><span className="pill pill-bad">cap reached: paid jobs wait until tomorrow</span></div> : null}
        </div>
        <div className="card">
          <div className="small muted">Jobs failed for good</div>
          <strong>{s.dead.length}</strong>
        </div>
        <div className="card">
          <div className="small muted">Open alerts</div>
          <strong>{s.alerts.length}</strong>
        </div>
      </div>
      {s.killSwitch ? <p className="small">The kill switch is on: no discovery or retest is started. Alerts, the digest and clean-up still run.</p> : null}

      <h2>Alerts</h2>
      {s.alerts.length === 0 ? <p className="muted">No open alerts.</p> : (
        <div className="stack">
          {s.alerts.map((a) => (
            <div className="card stack" key={a.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{a.title}</strong>
                <span className="small muted">{dateTime(a.created_at)}</span>
              </div>
              {a.body ? <pre className="small" style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit" }}>{short(a.body, 1200)}</pre> : null}
              <div className="row">
                {a.clinic_id ? <Link href={`/portal/clinic/${a.clinic_id}`}>Open clinic</Link> : null}
                <form action={dismissAlertAction.bind(null, a.id)}>
                  <button className="btn">Dismiss</button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2>Jobs that failed for good</h2>
      {s.dead.length === 0 ? <p className="muted">None.</p> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Job</th><th>Last error</th><th>Tries</th><th></th></tr></thead>
            <tbody>
              {s.dead.map((j) => (
                <tr key={j.id}>
                  <td>{j.kind}<div className="small muted">{j.idempotency_key}</div><div className="small muted">{dateTime(j.created_at)}</div></td>
                  <td className="small">{short(j.last_error) || "no error text"}</td>
                  <td>{j.attempts}</td>
                  <td>
                    <form action={retryJobAction.bind(null, j.id)}>
                      <button className="btn" aria-label={`Retry ${j.kind} job`}>Retry</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Jobs failing and being retried</h2>
      {s.failing.length === 0 ? <p className="muted">None.</p> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Job</th><th>Last error</th><th>Tries</th><th>Next try</th></tr></thead>
            <tbody>
              {s.failing.map((j) => (
                <tr key={j.id}>
                  <td>{j.kind}<div className="small muted">{j.idempotency_key}</div></td>
                  <td className="small">{short(j.last_error)}</td>
                  <td>{j.attempts} of {j.max_attempts}</td>
                  <td className="small">{dateTime(j.run_after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Monthly retests</h2>
      {s.retests.length === 0 ? <p className="muted">No active subscriptions.</p> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Clinic</th><th>Cycle</th><th>Due</th><th>State</th></tr></thead>
            <tbody>
              {s.retests.map((r) => (
                <tr key={r.clinicId}>
                  <td><Link href={`/portal/clinic/${r.clinicId}`}>{r.clinicName}</Link>{r.grace ? <div className="small muted">payment past due: one more cycle</div> : null}</td>
                  <td>{r.cycle}</td>
                  <td>{r.due}{r.due === s.day ? " (today)" : ""}</td>
                  <td>{jobPill(r.jobStatus, "not started")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Retests after a one-time purchase</h2>
      {s.purchaseRetests.length === 0 ? <p className="muted">None waiting.</p> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Clinic</th><th>Paid</th><th>Retest due</th><th>State</th></tr></thead>
            <tbody>
              {s.purchaseRetests.map((o) => (
                <tr key={o.id}>
                  <td>{o.clinic_id ? <Link href={`/portal/clinic/${o.clinic_id}`}>{o.name ?? "clinic"}</Link> : "no clinic"}</td>
                  <td>{date(o.paid_at)}</td>
                  <td>{date(o.due)}</td>
                  <td>{jobPill(o.job_status, "waiting")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Discovery ({s.month})</h2>
      <p className="small muted">
        Each active city and sector is searched once a month, {s.perDay} a business day, the one searched longest ago first.
      </p>
      <div className="table-scroll">
        <table>
          <thead><tr><th>City</th><th>Sector</th><th>Last run</th><th>This month</th></tr></thead>
          <tbody>
            {s.targets.map((t) => (
              <tr key={t.id}>
                <td>{t.city}</td>
                <td>{t.sector}</td>
                <td>{date(t.last_run_at)}</td>
                <td>
                  {!t.active ? <span className="muted">off</span> : jobPill(t.job_status, "waiting its turn")}
                  {t.job_status === "dead" ? <div className="small">{short(t.job_error, 120)}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Scheduled tasks</h2>
      {s.tasks.length === 0 ? <p className="muted">Nothing has run yet. The scheduler runs with the worker, every minute.</p> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Task</th><th>Last period</th><th>State</th><th>Finished</th></tr></thead>
            <tbody>
              {s.tasks.map((t) => (
                <tr key={t.name}>
                  <td>{t.name.replaceAll("_", " ")}</td>
                  <td>{t.period}</td>
                  <td>{jobPill(t.status, "")}{t.last_error ? <div className="small">{short(t.last_error, 120)}</div> : null}</td>
                  <td className="small">{dateTime(t.finished_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">The digest goes out on business days at {s.digestHour}:00 Toronto time, and only when there is something to report.</p>
    </section>
  );
}
