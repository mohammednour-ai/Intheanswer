import Link from "next/link";
import { ownerDetails } from "@/lib/env";
import styles from "./site.module.css";

/** The two offers, with the monthly plan visually dominant. */
export function Offers({ heading = "Two ways to fix it" }: { heading?: string }) {
  const o = ownerDetails();
  return (
    <section className={styles.section} aria-labelledby="offers-h">
      <h2 id="offers-h">{heading}</h2>
      <div className={styles.offers}>
        <div className={styles.offer}>
          <div className="small" style={{ fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase" }}>One time</div>
          <div className={styles.price}>200 CAD</div>
          <strong>Full report and fix files</strong>
          <p>Every finding with what we saw and the fix, plus ready-to-use files for your web person: question and answer drafts, one hours block, a fees and coverage template, structured data, a directory correction list, and the sources assistants used. One retest four weeks later.</p>
          <Link className="btn" href="/#get-report" style={{ marginTop: "auto", alignSelf: "flex-start" }}>Start with the free report</Link>
        </div>
        <div className={`${styles.offer} ${styles.offerMain}`}>
          <span className={styles.tag}>We do the work for you</span>
          <div className="small" style={{ fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase" }}>Monthly plan</div>
          <div className={styles.price}>200 CAD <span style={{ fontSize: "1rem", fontWeight: 500 }}>per month · minimum term {o.minTerm}</span></div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>Your website rebuilt or upgraded, with every fix installed by us</li>
            <li>Two new answer pages each month, written for the questions patients ask</li>
            <li>The same questions retested every month, with a before and after</li>
            <li>A watch on the clinics named beside you</li>
            <li>Hours, notices and listings kept current</li>
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
