import { overview } from "@/lib/portal/queries";

const usd = (n: number) => `$${n.toFixed(2)}`;

export default async function OverviewPage() {
  const o = await overview();
  return (
    <section className="stack">
      <h1>Overview</h1>
      <div className="row">
        <div className="card">
          <div className="small muted">One-time revenue</div>
          <strong>{(o.rev.one_time_cents / 100).toFixed(2)} CAD</strong>
        </div>
        <div className="card">
          <div className="small muted">Active subscriptions</div>
          <strong>{o.rev.subs_active}</strong>
        </div>
        <div className="card">
          <div className="small muted">Claude spend today</div>
          <strong>{usd(o.claudeTodayUsd)}</strong>
        </div>
        <div className="card">
          <div className="small muted">Avg cost per clinic</div>
          <strong>{o.perClinic.avg_usd == null ? "n/a" : usd(o.perClinic.avg_usd)}</strong>
          <div className="small muted">plus {usd(o.sharedCostUsd)} shared (city tests)</div>
        </div>
      </div>
      <h2>Funnel (clinics by stage)</h2>
      <table>
        <tbody>
          {o.funnel.map((f) => (
            <tr key={f.status}>
              <td>{f.status.replaceAll("_", " ")}</td>
              <td>{f.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Messages</h2>
      <table>
        <tbody>
          {o.messages.map((f) => (
            <tr key={f.status}>
              <td>{f.status.replaceAll("_", " ")}</td>
              <td>{f.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Cost per day (USD)</h2>
      <table>
        <tbody>
          {o.costPerDay.map((f) => (
            <tr key={f.day}>
              <td>{f.day}</td>
              <td>{usd(f.usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Jobs</h2>
      <table>
        <thead>
          <tr>
            <th>Kind</th>
            <th>Status</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody>
          {o.jobs.map((j) => (
            <tr key={j.kind + j.status}>
              <td>{j.kind}</td>
              <td>{j.status}</td>
              <td>{j.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
