"use client";

import { useActionState } from "react";
import { routingAction, type RoutingState } from "./actions";
import type { RoutingRules } from "@/lib/channels/settings";

const LABEL: Record<string, string> = { letter: "Letter", email: "Email", skipped: "Skipped", excluded: "Excluded", wait: "Waiting (cool-down)", done: "No further cold contact" };

export function RoutingForm({ rules }: { rules: RoutingRules }) {
  const [state, action, pending] = useActionState<RoutingState, FormData>(routingAction, null);
  const r = state?.rules ?? rules;
  const p = state?.preview;
  return (
    <form action={action} className="stack">
      <ol className="small" style={{ paddingLeft: 18, margin: 0 }}>
        <li>Chains, suppressed and opted-out clinics are excluded.</li>
        <li>
          <label htmlFor="thr">Lead score at or above this gets a letter first; below it, email first</label>
          <input id="thr" name="score_threshold" type="number" min={0} max={20} defaultValue={r.score_threshold} style={{ width: 100 }} />
        </li>
        <li>No public email: letter. No verified address: email. Neither: skipped and listed.</li>
        <li>
          <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" name="split_on" defaultChecked={r.split_on} style={{ width: 20, height: 20 }} /> Test split: assign new clinics at random, ignoring rule 2</label>
          <label htmlFor="pct">Share sent a letter (%)</label>
          <input id="pct" name="split_letter_pct" type="number" min={0} max={100} defaultValue={r.split_letter_pct} style={{ width: 100 }} />
        </li>
        <li>
          <label htmlFor="cd">Cool-down before the other channel is tried (days, minimum 14)</label>
          <input id="cd" name="cooldown_days" type="number" min={14} max={365} defaultValue={r.cooldown_days} style={{ width: 100 }} />
        </li>
        <li>Contact by consent (call-me, replies, email asked for on the results page) is never blocked by the cool-down.</li>
        <li>One mail piece per clinic, not per person.</li>
      </ol>
      <div className="row">
        <button className="btn" name="intent" value="preview" disabled={pending}>Preview next 100 clinics</button>
        <button className="btn btn-primary" name="intent" value="save" disabled={pending || !p}>Save rules</button>
        {!p && !state?.saved ? <span className="small muted">Preview before saving.</span> : null}
      </div>
      {state?.error ? <p className="pill pill-bad" role="alert">{state.error}</p> : null}
      {state?.saved ? <p className="pill pill-ok" role="status">Rules saved and logged.</p> : null}
      {p ? (
        <div>
          <p className="small"><strong>{p.total}</strong> clinics in the queue; <strong>{p.changed}</strong> would be routed differently.</p>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Outcome</th><th>Current rules</th><th>New rules</th></tr></thead>
              <tbody>
                {[...new Set([...Object.keys(p.counts.current), ...Object.keys(p.counts.proposed)])].map((k) => (
                  <tr key={k}><td>{LABEL[k] ?? k}</td><td>{p.counts.current[k] ?? 0}</td><td>{p.counts.proposed[k] ?? 0}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center" }}>Clinic by clinic</summary>
            <div className="table-scroll">
              <table>
                <thead><tr><th>Clinic</th><th>Current</th><th>New</th><th>Why (new)</th></tr></thead>
                <tbody>
                  {p.rows.map((x, i) => (
                    <tr key={i} style={x.changed ? { fontWeight: 600 } : undefined}>
                      <td>{x.name}</td><td>{LABEL[x.current.channel]}</td><td>{LABEL[x.proposed.channel]}{x.changed ? " (changed)" : ""}</td>
                      <td className="small">Rule {x.proposed.rule}: {x.proposed.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      ) : null}
    </form>
  );
}
