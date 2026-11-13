import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { markTaskDoneAction } from "./actions";

const when = (d: unknown) => (d ? new Date(d as Date).toLocaleDateString("en-CA", { timeZone: "America/Toronto" }) : "");
const money = (cents: unknown, currency: unknown) =>
  cents == null ? "" : `${(Number(cents) / 100).toFixed(2)} ${String(currency ?? "cad").toUpperCase()}`;

function pill(status: string) {
  const cls = ["paid", "active", "trialing"].includes(status)
    ? "pill pill-ok"
    : ["pending", "incomplete"].includes(status)
      ? "pill pill-blue"
      : ["partially_refunded", "past_due", "unpaid"].includes(status)
        ? "pill pill-warn"
        : "pill pill-bad";
  return <span className={cls}>{status.replaceAll("_", " ")}</span>;
}

export default async function CustomersPage() {
  await requireOwner();
  const sql = db();
  const tasks = await sql`
    select t.id, t.kind, t.title, t.body, t.created_at, t.clinic_id, coalesce(c.site_name, c.name) as clinic_name,
           f.token as intake_token, f.submitted_at
    from owner_tasks t left join clinics c on c.id = t.clinic_id
    left join intake_forms f on f.order_id = t.order_id
    where t.status = 'open' and t.kind = 'onboarding' order by t.created_at desc limit 100`;
  const subs = await sql`
    select s.id, s.plan, s.status, s.current_period_end, s.min_term_end, s.cancel_at, s.canceled_at, s.created_at, s.clinic_id,
           s.stripe_subscription_id, coalesce(c.site_name, c.name) as clinic_name
    from subscriptions s left join clinics c on c.id = s.clinic_id order by s.created_at desc limit 200`;
  const orders = await sql`
    select o.id, o.kind, o.plan, o.status, o.amount_cents, o.amount_refunded_cents, o.currency, o.customer_email, o.created_at, o.paid_at,
           o.refunded_at, o.clinic_id, coalesce(c.site_name, c.name) as clinic_name, r.token as report_token,
           m.id as delivery_id, m.status::text as delivery_status
    from orders o left join clinics c on c.id = o.clinic_id left join reports r on r.id = o.report_id
    left join messages m on m.idempotency_key = 'delivery:' || o.id::text
    where o.status <> 'failed' or o.created_at > now() - interval '14 days'
    order by coalesce(o.paid_at, o.created_at) desc limit 200`;
  const clinic = (id: unknown, name: unknown) => (id ? <Link href={`/portal/clinic/${id}`}>{(name as string) ?? "clinic"}</Link> : <span className="muted">unknown</span>);

  return (
    <section className="stack">
      <h1>Customers</h1>

      <h2>Onboarding to do</h2>
      {tasks.length === 0 ? (
        <p className="muted">No open onboarding tasks.</p>
      ) : (
        tasks.map((t) => (
          <div className="card stack" key={t.id as string}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{t.title as string}</strong>
              <span className="small muted">{when(t.created_at)}</span>
            </div>
            <div className="small">
              {clinic(t.clinic_id, t.clinic_name)}
              {t.intake_token ? (
                <> · <a href={`/intake/${t.intake_token}`}>intake form</a> {t.submitted_at ? <span className="pill pill-ok">received {when(t.submitted_at)}</span> : <span className="pill pill-blue">not yet sent in</span>}</>
              ) : null}
            </div>
            {t.body ? <p className="small" style={{ whiteSpace: "pre-wrap" }}>{t.body as string}</p> : null}
            <form action={markTaskDoneAction.bind(null, t.id as string)}>
              <button className="btn">Mark done</button>
            </form>
          </div>
        ))
      )}

      <h2>Subscriptions</h2>
      {subs.length === 0 ? (
        <p className="muted">No subscriptions yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Clinic</th><th>Plan</th><th>Status</th><th>Started</th><th>Paid to</th><th>Minimum term to</th><th>Ends</th></tr>
            </thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id as string}>
                  <td>{clinic(s.clinic_id, s.clinic_name)}<div className="small muted">{s.stripe_subscription_id as string}</div></td>
                  <td className="small">{s.plan === "reports" ? "Monthly reports" : "Full service"}</td>
                  <td>{pill(s.status as string)}</td>
                  <td className="small">{when(s.created_at)}</td>
                  <td className="small">{when(s.current_period_end)}</td>
                  <td className="small">{when(s.min_term_end)}</td>
                  <td className="small">{when(s.canceled_at ?? s.cancel_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Orders</h2>
      {orders.length === 0 ? (
        <p className="muted">No orders yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Clinic</th><th>What</th><th>Status</th><th>Amount</th><th>Date</th><th>Report</th></tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id as string}>
                  <td>{clinic(o.clinic_id, o.clinic_name)}<div className="small muted">{o.customer_email as string}</div></td>
                  <td>{o.kind !== "subscription" ? "Full report" : o.plan === "reports" ? "Monthly reports (first payment)" : "Full service plan (first payment)"}</td>
                  <td>{pill(o.status as string)}</td>
                  <td className="small">
                    {money(o.amount_cents, o.currency)}
                    {Number(o.amount_refunded_cents) > 0 ? <div className="muted">refunded {money(o.amount_refunded_cents, o.currency)}</div> : null}
                  </td>
                  <td className="small">{when(o.paid_at ?? o.created_at)}</td>
                  <td className="small">
                    {o.report_token ? <a href={`/r/${o.report_token}?preview=owner`}>report</a> : <span className="muted">not built</span>}
                    {o.delivery_id ? <> · <Link href={`/portal/item/${o.delivery_id}`}>email: {(o.delivery_status as string).replaceAll("_", " ")}</Link></> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
