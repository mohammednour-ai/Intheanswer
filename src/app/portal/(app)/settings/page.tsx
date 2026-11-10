import { db } from "@/lib/db";
import { getSettings, getModes, MODE_TYPES, effectiveDryRun } from "@/lib/settings";
import { warmupCapForDate } from "@/lib/sending/rules";
import { localDate } from "@/lib/time";
import { ownerDetailsComplete } from "@/lib/env";
import {
  setModeAction,
  setKillSwitchAction,
  clearAutoPauseAction,
  saveSendingAction,
  setLiveAction,
  saveCityAction,
  toggleTargetAction,
  saveQuestionsAction,
  saveSectorAction,
} from "./actions";

export default async function SettingsPage() {
  const s = await getSettings();
  const modes = await getModes();
  const dry = await effectiveDryRun(s);
  const owner = ownerDetailsComplete();
  const sql = db();
  const sectors = await sql`select * from sectors order by id`;
  const targets = await sql`
    select t.id, t.active, s.name as sector, c.name as city, t.last_run_at
    from discovery_targets t join sectors s on s.id=t.sector_id join cities c on c.id=t.city_id order by c.name, s.id`;
  const qsets = await sql`select distinct on (sector_id) * from question_sets where active order by sector_id, version desc`;
  const capToday = warmupCapForDate(s, localDate(new Date()));

  return (
    <div className="stack">
      <h1>Settings</h1>

      <section className="card stack" aria-labelledby="kill-h">
        <h2 id="kill-h">Kill switch</h2>
        <p>{s.kill_switch ? "On: nothing is sent." : "Off: sending follows the rules below."}</p>
        <form action={setKillSwitchAction.bind(null, !s.kill_switch)}>
          <button className={s.kill_switch ? "btn" : "btn btn-danger"}>
            {s.kill_switch ? "Turn kill switch off" : "Stop all sending now"}
          </button>
        </form>
        {s.auto_paused && (
          <form action={clearAutoPauseAction}>
            <p>Auto-paused: {s.auto_pause_reason}</p>
            <button className="btn">Clear auto-pause</button>
          </form>
        )}
        {s.pipeline_paused_for_spend && (
          <p className="small">
            The pipeline is paused because today&apos;s Claude spend reached the cap. It resumes automatically
            tomorrow (Toronto time), or now if you raise the cap below.
          </p>
        )}
      </section>

      <section className="card stack" aria-labelledby="modes-h">
        <h2 id="modes-h">Approval mode per message type</h2>
        <p className="small muted">
          Changing a mode affects new items only. Items already queued stay until you act on them. Payment receipts
          and unsubscribe confirmations are always automatic. The verification gate holds flagged items in both modes.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Mode</th>
                <th>First N still reviewed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {MODE_TYPES.map(({ type, label }) => {
                const m = modes.find((x) => x.type === type);
                const left = m && m.mode === "AUTO" ? Math.max(0, m.review_first_n - m.auto_created_count) : null;
                return (
                  <tr key={type}>
                    <td>
                      {label}
                      {left !== null && left > 0 ? <div className="small muted">{left} more will come to you</div> : null}
                    </td>
                    <td colSpan={3}>
                      <form action={setModeAction.bind(null, type)} className="row">
                        <label className="sr-only" htmlFor={`mode-${type}`}>Mode for {label}</label>
                        <select id={`mode-${type}`} name="mode" defaultValue={m?.mode ?? "REVIEW"} style={{ width: 130 }}>
                          <option value="REVIEW">REVIEW</option>
                          <option value="AUTO">AUTO</option>
                        </select>
                        <label className="sr-only" htmlFor={`n-${type}`}>First N reviewed</label>
                        <input id={`n-${type}`} name="review_first_n" type="number" min={0} max={1000}
                          defaultValue={m?.review_first_n ?? s.auto_review_first_n} style={{ width: 100 }} />
                        <button className="btn">Save</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card stack" aria-labelledby="send-h">
        <h2 id="send-h">Sending</h2>
        <p className="small">
          Warm-up cap today: <strong>{capToday}</strong> per day (starts at {s.warmup_start_per_day}, +{s.warmup_step_per_week} per week, ceiling {s.warmup_ceiling}).
          DNS verified: <strong>{s.dns_verified ? "yes" : "no (sending refused)"}</strong>.
        </p>
        <form action={saveSendingAction} className="stack">
          <div className="row">
            <div>
              <label htmlFor="warm">Warm-up start date</label>
              <input id="warm" name="warmup_start_date" type="text" placeholder="YYYY-MM-DD" defaultValue={s.warmup_start_date ?? ""} />
            </div>
            <div>
              <label htmlFor="cap">Daily cap override (lower only)</label>
              <input id="cap" name="daily_cap_override" type="number" min={0} max={40} defaultValue={s.daily_cap_override ?? ""} />
            </div>
          </div>
          <div className="row">
            <div>
              <label htmlFor="ws">Sending hours start (Toronto)</label>
              <input id="ws" name="send_window_start" type="time" defaultValue={s.send_window_start} />
            </div>
            <div>
              <label htmlFor="we">Sending hours end</label>
              <input id="we" name="send_window_end" type="time" defaultValue={s.send_window_end} />
            </div>
          </div>
          <div className="row">
            <div>
              <label htmlFor="spend">Daily API spend cap, all paid APIs (USD)</label>
              <input id="spend" name="claude_daily_spend_cap_usd" type="number" min={0} step="0.01" defaultValue={s.claude_daily_spend_cap_usd} />
            </div>
            <div>
              <label htmlFor="firstn">Default first N reviewed when switching to AUTO</label>
              <input id="firstn" name="auto_review_first_n" type="number" min={0} defaultValue={s.auto_review_first_n} />
            </div>
          </div>
          <div className="row">
            <div>
              <label htmlFor="ppm">Monthly plan: new pages per month</label>
              <input id="ppm" name="pages_per_month" type="number" min={0} max={20} defaultValue={s.pages_per_month} />
            </div>
            <div>
              <label htmlFor="cap2">Site test page cap per site</label>
              <input id="cap2" name="crawl_page_cap" type="number" min={5} max={200} defaultValue={s.crawl_page_cap} />
            </div>
            <div>
              <label htmlFor="cache">Speed results cache (days)</label>
              <input id="cache" name="api_cache_days" type="number" min={1} max={30} defaultValue={s.api_cache_days} />
            </div>
          </div>
          <button className="btn btn-primary">Save settings</button>
        </form>
      </section>

      <section className="card stack" aria-labelledby="live-h">
        <h2 id="live-h">Live or dry run</h2>
        <p>
          Currently: <strong>{dry ? "dry run" : "live"}</strong>. Going live needs DRY_RUN=0 in the environment, owner
          details filled in{owner.ok ? "" : ` (missing: ${owner.missing.join(", ")})`}, DNS verified, and this switch.
        </p>
        <form action={setLiveAction.bind(null, !s.live_enabled)}>
          <button className="btn">{s.live_enabled ? "Switch back to dry run" : "Enable live mode"}</button>
        </form>
      </section>

      <section className="card stack" aria-labelledby="targets-h">
        <h2 id="targets-h">Sectors and cities</h2>
        <div className="table-scroll">
          <table>
            <thead><tr><th>City</th><th>Sector</th><th>Last discovery</th><th>Active</th></tr></thead>
            <tbody>
              {targets.map((t) => (
                <tr key={t.id as number}>
                  <td>{t.city as string}</td>
                  <td>{t.sector as string}</td>
                  <td className="small">{t.last_run_at ? new Date(t.last_run_at as Date).toLocaleDateString("en-CA") : "never"}</td>
                  <td>
                    <form action={toggleTargetAction.bind(null, t.id as number, !t.active)}>
                      <button className="btn">{t.active ? "On" : "Off"}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form action={saveCityAction} className="row">
          <div><label htmlFor="cname">Add city</label><input id="cname" name="name" type="text" required /></div>
          <div><label htmlFor="clat">Lat</label><input id="clat" name="lat" type="number" step="any" style={{ width: 120 }} /></div>
          <div><label htmlFor="clng">Lng</label><input id="clng" name="lng" type="number" step="any" style={{ width: 120 }} /></div>
          <div><label htmlFor="crad">Radius m</label><input id="crad" name="radius_m" type="number" defaultValue={15000} style={{ width: 120 }} /></div>
          <button className="btn">Add city</button>
        </form>
        <details>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>Add or edit a sector</summary>
          <form action={saveSectorAction} className="stack">
            <div><label htmlFor="sslug">Slug</label><input id="sslug" name="slug" type="text" required /></div>
            <div><label htmlFor="sname">Name</label><input id="sname" name="name" type="text" required /></div>
            <div><label htmlFor="snoun">What patients call it</label><input id="snoun" name="patient_noun" type="text" required /></div>
            <div><label htmlFor="squery">Places search (with {"{city}"})</label><input id="squery" name="places_query" type="text" required /></div>
            <div><label htmlFor="sreg">Regulator line</label><input id="sreg" name="regulator_note" type="text" required /></div>
            <button className="btn">Save sector</button>
          </form>
        </details>
      </section>

      <section className="card stack" aria-labelledby="q-h">
        <h2 id="q-h">Question sets</h2>
        <p className="small muted">Five or six questions per sector, written the way a patient asks. Use {"{city}"}. Saving creates a new version; monthly retests keep the version a clinic started with.</p>
        {sectors.map((sec) => {
          const qs = qsets.find((q) => q.sector_id === sec.id);
          return (
            <form key={sec.id as number} action={saveQuestionsAction.bind(null, sec.id as number)} className="stack">
              <label htmlFor={`q-${sec.id}`}>{sec.name as string} (version {(qs?.version as number) ?? 0})</label>
              <textarea id={`q-${sec.id}`} name="questions" rows={7} defaultValue={((qs?.questions as string[]) ?? []).join("\n")} />
              <button className="btn">Save questions</button>
            </form>
          );
        })}
      </section>
    </div>
  );
}
