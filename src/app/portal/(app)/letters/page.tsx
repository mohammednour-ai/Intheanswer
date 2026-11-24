import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { letterSettings, postgridConfigured, spentThisMonthUsd } from "@/lib/letters/letters";
import { approveAllAction, prepareNowAction, saveLetterSettingsAction, setLettersLiveAction } from "./actions";
import { LETTER_STATUS as STATUS } from "./status";

const when = (d: Date | null) => (d ? new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium" }) : "");

export default async function LettersPage(props: PageProps<"/portal/letters">) {
  await requireOwner();
  const sp = await props.searchParams;
  const s = letterSettings(await getSettings());
  const pg = postgridConfigured();
  const spent = await spentThisMonthUsd();
  const rows = await db()<{ id: string; to_name: string; status: string; created_at: Date; sent_at: Date | null; live: boolean | null; visit_count: number; provider_status: string | null; stopped_at: Date | null; last_error: string | null; reject_reason: string | null }[]>`
    select id, to_name, status, created_at, sent_at, live, visit_count, provider_status, stopped_at, last_error, reject_reason
    from letters order by case status when 'review' then 0 when 'held' then 1 when 'approved' then 2 else 3 end, created_at desc limit 300`;
  const waiting = rows.filter((r) => r.status === "review").length;
  const ok = typeof sp.ok === "string" ? sp.ok.slice(0, 400) : null;
  const error = typeof sp.error === "string" ? sp.error.slice(0, 600) : null;

  return (
    <section className="stack">
      <h1>Letters</h1>
      <p className="muted">
        One printed letter per clinic, ever: for a clinic we emailed {s.afterDays} days ago or more that has not replied, opened its report,
        phoned, bought or opted out. It repeats what the email said, with a QR code to the report and our phone line. Every letter waits here for
        your approval, and the clinic is checked again when you approve.
      </p>
      {ok ? <p className="pill pill-ok" role="status">{ok}</p> : null}
      {error ? <p className="pill pill-bad" role="alert">{error}</p> : null}

      <div className="card stack">
        <p className="small" style={{ margin: 0 }}>
          Preparing letters: <strong>{s.enabled ? "on" : "off"}</strong> · Real mailing: <strong>{s.live ? "on" : "off"}</strong>
          {" "}· PostGrid key: <strong>{pg.key ? "set" : "not set"}</strong> · Status updates: <strong>{pg.webhook ? "set" : "not set"}</strong>
          {" "}· This month: US${spent.toFixed(2)} of US${s.budgetUsd.toFixed(2)}
        </p>
        {!s.live ? (
          <p className="small muted" style={{ margin: 0 }}>
            While real mailing is off, a letter to a clinic is only accepted with PostGrid&apos;s test key, which never prints anything. With the
            live key, use &ldquo;Send a copy to me&rdquo; on a letter to see the print first.
          </p>
        ) : null}
        <div className="row">
          <form action={prepareNowAction}><button className="btn">Prepare letters now</button></form>
          {waiting ? <form action={approveAllAction}><button className="btn btn-primary">Approve all {waiting} waiting</button></form> : null}
          <form action={setLettersLiveAction.bind(null, !s.live)}>
            <button className={s.live ? "btn btn-danger" : "btn"}>{s.live ? "Turn real mailing off" : "Turn real mailing on"}</button>
          </form>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="muted">No letters yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Clinic</th><th>Status</th><th>Prepared</th><th>Posted</th><th>Visits</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const st = STATUS[r.status] ?? { t: r.status, cls: "" };
                return (
                  <tr key={r.id}>
                    <td><Link href={`/portal/letters/${r.id}`}>{r.to_name}</Link></td>
                    <td>
                      <span className={`pill ${st.cls}`}>{st.t}</span>
                      {r.status === "sent" && !r.live ? <> <span className="pill pill-warn">test</span></> : null}
                      {r.stopped_at ? <> <span className="pill pill-bad">asked to stop</span></> : null}
                      {r.provider_status && r.status === "sent" ? <div className="small muted">{r.provider_status.replace(/_/g, " ")}</div> : null}
                      {r.status === "failed" && r.last_error ? <div className="small muted">{r.last_error}</div> : null}
                    </td>
                    <td className="small">{when(r.created_at)}</td>
                    <td className="small">{when(r.sent_at)}</td>
                    <td>{r.visit_count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <form action={saveLetterSettingsAction} className="card stack" aria-labelledby="letters-settings-h">
        <h2 id="letters-settings-h" style={{ margin: 0 }}>Settings</h2>
        <label className="row"><input type="checkbox" name="letters_enabled" defaultChecked={s.enabled} /> Prepare letters each business day (from 8:00)</label>
        <div className="row">
          <div><label htmlFor="after">Days after the email</label><input id="after" name="letter_after_days" type="number" min={3} max={90} defaultValue={s.afterDays} /></div>
          <div><label htmlFor="perday">Letters prepared a day</label><input id="perday" name="letters_per_day" type="number" min={0} max={100} defaultValue={s.perDay} /></div>
          <div><label htmlFor="cost">Cost per letter (US$)</label><input id="cost" name="letter_cost_usd" type="number" step="0.01" min={0} max={20} defaultValue={s.costUsd} /></div>
          <div><label htmlFor="budget">Monthly limit (US$)</label><input id="budget" name="letters_monthly_budget_usd" type="number" step="1" min={0} max={10000} defaultValue={s.budgetUsd} /></div>
        </div>
        <div>
          <label htmlFor="class">Canada Post service</label>
          <select id="class" name="letter_mailing_class" defaultValue={s.mailingClass}>
            <option value="ca_post_lettermail">Lettermail (about US$2.22 a colour letter)</option>
            <option value="ca_post_personalized">Personalized Mail (about US$1.47, at least 200 letters)</option>
          </select>
          <p className="small muted">
            PostGrid lists Lettermail for non-marketing mail and Personalized Mail for marketing with a minimum of 200 letters. Ask PostGrid which one
            these letters may use before turning real mailing on.
          </p>
        </div>
        <button className="btn btn-primary">Save</button>
      </form>
    </section>
  );
}
