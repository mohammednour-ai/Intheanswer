"use client";

import Link from "next/link";
import { useActionState } from "react";
import { requestReport, type FormState } from "./actions";
import site from "./site.module.css";
import styles from "./home.module.css";

/**
 * The free report form. Renders the contents of the blue form panel; the page supplies the panel itself
 * (the element with id="get-report").
 */
export function SelfServeBox() {
  const [state, action, pending] = useActionState<FormState, FormData>(requestReport, null);
  const v = state?.values;
  return (
    <>
      <div className={styles.panelHead}>
        <span className={styles.panelBar} aria-hidden="true" />
        <h2 id="ss-h" className={styles.panelTitle}>Get your clinic&apos;s free report</h2>
      </div>
      <form action={action} key={state?.ok ? "done" : "form"} className={styles.form} aria-labelledby="ss-h">
        <div className={styles.field}>
          <label htmlFor="website" className={styles.label}>Clinic website</label>
          <input className={styles.input} id="website" name="website" type="text" inputMode="url" autoComplete="url" placeholder="yourclinic.ca" required defaultValue={v?.website} />
        </div>
        <div className={styles.field}>
          <label htmlFor="email" className={styles.label}>Email at the clinic</label>
          <input className={styles.input} id="email" name="email" type="email" autoComplete="email" required aria-describedby="email-help" defaultValue={v?.email} />
          <span id="email-help" className={styles.help}>Use an address on your clinic&apos;s domain, or the one shown on your website.</span>
        </div>
        <div className={styles.pair}>
          <div className={styles.field}>
            <label htmlFor="sector" className={styles.label}>Type of clinic</label>
            <select className={`${styles.input} ${styles.select}`} id="sector" name="sector" required defaultValue={v?.sector ?? ""} key={v?.sector ?? "none"}>
              <option value="" disabled>Choose</option>
              <option value="dental">Dental clinic</option>
              <option value="family">Walk-in or family clinic</option>
              <option value="medspa">Medspa</option>
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="city" className={`${styles.label} ${styles.nowrap}`}>City or town (Ontario)</label>
            <input className={styles.input} id="city" name="city" type="text" autoComplete="address-level2" required defaultValue={v?.city} />
          </div>
        </div>
        <div className={site.hp} aria-hidden="true">
          {/* A trap for bots. The name must not look like a real field: browsers autofill "company". */}
          <label htmlFor="ita-check">Leave this empty</label>
          <input id="ita-check" name="ita_check_7q" type="text" tabIndex={-1} autoComplete="off" data-1p-ignore data-lpignore="true" defaultValue="" />
        </div>
        <button className={styles.submit} disabled={pending}>{pending ? "Sending" : "Send me the report"}</button>
        {state ? <p role="status" className={`${styles.status} ${state.ok ? styles.statusOk : styles.statusBad}`}>{state.message}</p> : null}
        <p className={styles.note}>Free. We read only your public website. We email the report once and do not add you to a list.</p>
      </form>
      <Link href="/sample" className={styles.lookFirst}>
        Or look first: see a sample report
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
      </Link>
    </>
  );
}
