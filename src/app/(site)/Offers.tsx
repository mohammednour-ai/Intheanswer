import Link from "next/link";
import { ownerDetails } from "@/lib/env";
import styles from "./site.module.css";

/** The three offers, with the full service plan visually dominant. */
export function Offers({ heading = "Three ways to fix it" }: { heading?: string }) {
  const o = ownerDetails();
  const label = { fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase" } as const;
  const small = { fontSize: "1rem", fontWeight: 500 } as const;
  return (
    <section className={styles.section} aria-labelledby="offers-h">
      <h2 id="offers-h">{heading}</h2>
      <div className={styles.offers}>
        <div className={styles.offer}>
          <div className="small" style={label}>One time</div>
          <div className={styles.price}>200 CAD</div>
          <strong>Full report and fix files</strong>
          <p>Every finding with what we saw and the fix, plus ready-to-use files for your web person: question and answer drafts, one hours block, a fees and coverage template, structured data, a directory correction list, and the sources assistants used. One retest four weeks later, with a second report showing what changed.</p>
          <Link className="btn" href="/#get-report" style={{ marginTop: "auto", alignSelf: "flex-start" }}>Start with the free report</Link>
        </div>
        <div className={styles.offer}>
          <div className="small" style={label}>Monthly reports</div>
          <div className={styles.price}>150 CAD <span style={small}>first month</span></div>
          <strong>then 50 CAD per month · minimum term {o.reportsMinTerm}</strong>
          <p>The full report and fix files in the first month. After that, the same questions and your website are retested every month and you get the updated report, with what changed since the last one. Your web person installs the fixes.</p>
          <Link className="btn" href="/#get-report" style={{ marginTop: "auto", alignSelf: "flex-start" }}>Start with the free report</Link>
        </div>
        <div className={`${styles.offer} ${styles.offerMain}`}>
          <span className={styles.tag}>We do the work for you</span>
          <div className="small" style={label}>Full service plan</div>
          <div className={styles.price}>200 CAD <span style={small}>per month · {o.contractTerm} contract</span></div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>Your website renovated, or taken over and run by us, with every fix installed</li>
            <li>Two new answer pages each month, written for the questions patients ask</li>
            <li>The same questions retested every month, with a before and after</li>
            <li>A watch on the clinics named beside you</li>
            <li>Hours, notices and listings kept current</li>
            <li>Questions answered within one business day</li>
          </ul>
          <Link className={`btn ${styles.btnLight}`} href="/#get-report" style={{ alignSelf: "flex-start" }}>Start with the free report</Link>
        </div>
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>
        Prices are in Canadian dollars, plus HST. No one can guarantee what an AI assistant will say; we report what it said and fix what we can see.
      </p>
    </section>
  );
}
