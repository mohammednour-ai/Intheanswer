"use client";

import { useActionState } from "react";
import { requestReport, type FormState } from "./actions";
import styles from "./site.module.css";

export function SelfServeBox() {
  const [state, action, pending] = useActionState<FormState, FormData>(requestReport, null);
  const v = state?.values;
  return (
    <form action={action} key={state?.ok ? "done" : "form"} className={`${styles.box} stack`} aria-labelledby="ss-h">
      <h2 id="ss-h" style={{ fontSize: "1.25rem" }}>Get your clinic&apos;s free report</h2>
      <div>
        <label htmlFor="website">Clinic website</label>
        <input id="website" name="website" type="text" inputMode="url" autoComplete="url" placeholder="yourclinic.ca" required defaultValue={v?.website} />
      </div>
      <div>
        <label htmlFor="email">Email at the clinic</label>
        <input id="email" name="email" type="email" autoComplete="email" required aria-describedby="email-help" defaultValue={v?.email} />
        <div id="email-help" className="small muted">Use an address on your clinic&apos;s domain, or the one shown on your website.</div>
      </div>
      <div className="row">
        <div style={{ flex: 1, minWidth: 140 }}>
          <label htmlFor="sector">Type of clinic</label>
          <select id="sector" name="sector" required defaultValue={v?.sector ?? ""} key={v?.sector ?? "none"}>
            <option value="" disabled>Choose</option>
            <option value="dental">Dental clinic</option>
            <option value="family">Walk-in or family clinic</option>
            <option value="medspa">Medspa</option>
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <label htmlFor="city">City or town (Ontario)</label>
          <input id="city" name="city" type="text" autoComplete="address-level2" required defaultValue={v?.city} />
        </div>
      </div>
      <div className={styles.hp} aria-hidden="true">
        <label htmlFor="company">Leave this empty</label>
        <input id="company" name="company" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <button className="btn btn-primary" disabled={pending}>{pending ? "Sending" : "Send me the report"}</button>
      {state ? <p role="status" className={`pill ${state.ok ? "pill-ok" : "pill-bad"}`} style={{ whiteSpace: "normal" }}>{state.message}</p> : null}
      <p className="small muted">Free. We read only your public website. We email the report once and do not add you to a list.</p>
    </form>
  );
}
