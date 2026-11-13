import Link from "next/link";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { CHANNELS, CHANNEL_LABELS, channelOpen, channelUsage, getChannel, getRouting, type LetterValues } from "@/lib/channels/settings";
import { RoutingForm } from "./RoutingForm";
import { killSwitchAction, saveChannelAction } from "./actions";

export default async function ChannelsSettings() {
  const s = await getSettings();
  const rules = await getRouting();
  const rows = await Promise.all(CHANNELS.map(async (c) => ({ c, v: await getChannel(c), u: await channelUsage(c), gate: await channelOpen(c) })));
  const log = await db()`select scope, actor, before, after, at from settings_audit_log order by at desc limit 30`;
  return (
    <div className="stack">
      <p><Link href="/portal/settings">Back to settings</Link></p>
      <h1>Channels</h1>

      <section className="card stack">
        <h2>Kill switch: all outbound channels</h2>
        <p>{s.kill_switch ? "On: no email, letter or call goes out." : "Off."}</p>
        <form action={killSwitchAction.bind(null, !s.kill_switch)}>
          <button className={s.kill_switch ? "btn" : "btn btn-danger"}>{s.kill_switch ? "Turn kill switch off" : "Stop all outbound now"}</button>
        </form>
      </section>

      {rows.map(({ c, v, u, gate }) => (
        <section key={c} className="card stack" aria-labelledby={`h-${c}`}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 id={`h-${c}`}>{CHANNEL_LABELS[c]}</h2>
            <span className={`pill ${gate.open ? "pill-ok" : "pill-warn"}`}>{gate.open ? "Open" : gate.reason}</span>
          </div>
          <p className="small muted">Today: {u.today} of {v.daily_cap}. This month: {u.monthUsd.toFixed(2)} of {v.monthly_spend_cap_usd} USD.</p>
          <form action={saveChannelAction.bind(null, c)} className="stack">
            <div className="row">
              <label className="row" style={{ fontWeight: 600 }}><input type="checkbox" name="on" defaultChecked={v.on} style={{ width: 20, height: 20 }} /> On</label>
              <div><label htmlFor={`p-${c}`}>Pause until</label><input id={`p-${c}`} name="pause_until" type="date" defaultValue={v.pause_until ?? ""} /></div>
              <div><label htmlFor={`d-${c}`}>Daily cap</label><input id={`d-${c}`} name="daily_cap" type="number" min={0} defaultValue={v.daily_cap} style={{ width: 110 }} /></div>
              <div><label htmlFor={`m-${c}`}>Monthly spend cap (USD)</label><input id={`m-${c}`} name="monthly_spend_cap_usd" type="number" min={0} step="0.01" defaultValue={v.monthly_spend_cap_usd} style={{ width: 130 }} /></div>
              <div>
                <label htmlFor={`o-${c}`}>Mode</label>
                {c === "letter" ? (
                  <><input type="hidden" name="mode" value="REVIEW" /><div id={`o-${c}`} className="pill">REVIEW (locked)</div></>
                ) : (
                  <select id={`o-${c}`} name="mode" defaultValue={v.mode} style={{ width: 130 }}><option value="REVIEW">REVIEW</option><option value="AUTO">AUTO</option></select>
                )}
              </div>
            </div>
            {c === "letter" ? (
              <div className="row">
                <div><label htmlFor="cl">Cost per letter (USD)</label><input id="cl" name="cost_letter" type="number" step="0.01" min={0} defaultValue={((v as LetterValues).cost_letter_cents / 100).toFixed(2)} style={{ width: 120 }} /></div>
                <div><label htmlFor="cp">Cost per postcard (USD)</label><input id="cp" name="cost_postcard" type="number" step="0.01" min={0} defaultValue={((v as LetterValues).cost_postcard_cents / 100).toFixed(2)} style={{ width: 120 }} /></div>
                <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" name="color" defaultChecked={(v as LetterValues).color} style={{ width: 20, height: 20 }} /> Colour print</label>
                <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" name="headline_test" defaultChecked={(v as LetterValues).headline_test} style={{ width: 20, height: 20 }} /> Test two headlines within each batch</label>
              </div>
            ) : null}
            {c === "inbound" ? (
              <div><label htmlFor="num">Inbound number printed on letters</label><input id="num" name="number" type="text" defaultValue={String(v.number ?? "")} style={{ maxWidth: 260 }} /></div>
            ) : null}
            <button className="btn">Save {CHANNEL_LABELS[c].toLowerCase()}</button>
          </form>
        </section>
      ))}

      <section className="card stack">
        <h2>Routing rules</h2>
        <p className="small muted">Applied in this order. The lead score is the send priority shown in the queue.</p>
        <RoutingForm rules={rules} />
      </section>

      <section>
        <h2>Change log</h2>
        {log.length === 0 ? <p className="muted">No changes yet.</p> : (
          <ul className="small">
            {log.map((l, i) => (
              <li key={i}>{new Date(l.at as Date).toLocaleString("en-CA", { timeZone: "America/Toronto" })}: {l.scope as string} changed by {l.actor as string}
                <details><summary style={{ cursor: "pointer" }}>Before and after</summary><pre>{JSON.stringify({ before: l.before, after: l.after }, null, 1)}</pre></details></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
