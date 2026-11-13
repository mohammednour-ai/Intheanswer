import Link from "next/link";
import { ownerDetails } from "@/lib/env";
import styles from "./site.module.css";

/** Twelve cells, the first `months` filled: how long each option commits you, at a glance. */
function Meter({ months }: { months: number }) {
  return (
    <span className={styles.meter} aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <span key={i} className={i < months ? styles.on : undefined} />
      ))}
    </span>
  );
}

/** "3 months" -> 3; a placeholder term draws an empty meter. */
const monthsOf = (term: string) => Math.min(12, Number(term.match(/^(\d+)/)?.[1] ?? 0));

/**
 * The three paid options as cards whose rows line up (price, who installs, commitment, retests, what you get).
 * The full service plan is the ink card; only "We do the work for you" is blue.
 */
export function Offers({
  heading = "Three ways to fix it",
  eyebrow = "What does fixing it cost?",
  headingLevel = 2,
}: {
  heading?: string;
  eyebrow?: string;
  headingLevel?: 2 | 3;
}) {
  const o = ownerDetails();
  const H = headingLevel === 2 ? "h2" : "h3";
  const Name = headingLevel === 2 ? "h3" : "h4";
  const reportsTerm = `Minimum term ${o.reportsMinTerm}`;
  const contract = `${o.contractTerm} contract`;
  return (
    <section className={`${styles.band} ${styles.bandRule}`} aria-labelledby="plans-h">
      <div className={`${styles.container} ${styles.stack}`}>
        <div className={styles.split}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span className={styles.eyebrow}>{eyebrow}</span>
            <H id="plans-h" className={styles.h2}>{heading}</H>
          </div>
          <div>
            <p className={styles.body2} style={{ margin: 0 }}>
              Two things separate the options: who installs the fixes, and how long you commit. Each card states them on the same lines.
            </p>
            <ul className={styles.glance} aria-label="The three options in brief">
              <li><strong>One time: 200 CAD</strong><span>Your web person installs. No contract.</span></li>
              <li><strong>Monthly reports: 150 CAD, then 50 CAD per month</strong><span>Your web person installs. {reportsTerm}.</span></li>
              <li><strong>Full service plan: 200 CAD per month</strong><span>We do the work for you. {contract[0].toUpperCase() + contract.slice(1)}.</span></li>
            </ul>
          </div>
        </div>

        <div className={styles.plans}>
          <article className={styles.plan}>
            <div className={styles.planHead}>
              <Name className={styles.planName}>One time</Name>
              <p className={styles.planPrice}>200 CAD</p>
              <p className={styles.planSub}>Full report and fix files</p>
            </div>
            <dl className={`${styles.planRow} ${styles.planRowFirst}`}><dt>Who installs the fixes</dt><dd className={styles.planValue}>Your web person</dd></dl>
            <dl className={styles.planRow}><dt>How long you commit</dt><dd><Meter months={0} /><span className={styles.planValue}>No contract</span></dd></dl>
            <dl className={styles.planRow}><dt>Retests</dt><dd className={styles.planRetest}>One retest four weeks later</dd></dl>
            <ul className={styles.planList}>
              <li>Every finding, with what we saw and the fix</li>
              <li>Ready-to-use files for your web person: question and answer drafts, one hours block, a fees and coverage template, structured data, a directory correction list, and the sources assistants used</li>
              <li>A second report after the retest, showing what changed</li>
            </ul>
          </article>

          <article className={styles.plan}>
            <div className={styles.planHead}>
              <Name className={styles.planName}>Monthly reports</Name>
              <p className={styles.planPrice}>150 CAD</p>
              <p className={styles.planSub}>first month, then 50 CAD per month</p>
            </div>
            <dl className={`${styles.planRow} ${styles.planRowFirst}`}><dt>Who installs the fixes</dt><dd className={styles.planValue}>Your web person</dd></dl>
            <dl className={styles.planRow}><dt>How long you commit</dt><dd><Meter months={monthsOf(o.reportsMinTerm)} /><span className={styles.planValue}>{reportsTerm}</span></dd></dl>
            <dl className={styles.planRow}><dt>Retests</dt><dd className={styles.planRetest}>Retested every month</dd></dl>
            <ul className={styles.planList}>
              <li>The full report and fix files in the first month</li>
              <li>After that, the same questions and your website are retested every month</li>
              <li>The updated report, with what changed since the last one</li>
            </ul>
          </article>

          <article className={`${styles.plan} ${styles.planMain}`}>
            <div className={styles.planHead}>
              <Name className={styles.planName}>Full service plan</Name>
              <p className={styles.planPrice}>200 CAD</p>
              <p className={styles.planSub}>per month</p>
            </div>
            <dl className={`${styles.planRow} ${styles.planRowFirst}`}><dt>Who installs the fixes</dt><dd><span className={styles.weDo}>We do the work for you</span></dd></dl>
            <dl className={styles.planRow}><dt>How long you commit</dt><dd><Meter months={monthsOf(o.minTerm)} /><span className={styles.planValue}>{contract[0].toUpperCase() + contract.slice(1)}</span></dd></dl>
            <dl className={styles.planRow}><dt>Retests</dt><dd className={styles.planRetest}>Retested every month</dd></dl>
            <ul className={styles.planList}>
              <li>Your website renovated, or taken over and run by us, with every fix installed</li>
              <li>Two new answer pages each month, written for the questions patients ask</li>
              <li>The same questions retested every month, with a before and after</li>
              <li>A watch on the clinics named beside you</li>
              <li>Hours, notices and listings kept current</li>
              <li>Questions answered within one business day</li>
            </ul>
          </article>
        </div>

        <div className={styles.actions}>
          <Link className={styles.btnPrimary} href="/#get-report">Start with the free report</Link>
          <Link className={styles.btnOutline} href="/pricing#questions">
            Contract, cancelling and refunds
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
          </Link>
          <p className={styles.body2} style={{ flex: "1 1 280px", minWidth: 0, margin: 0, fontSize: 15 }}>
            All three start in the same place. You read your free report first, and buy from it only if you want to.
          </p>
        </div>
        <p className={styles.fine} style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
          Prices are in Canadian dollars, plus HST. No one can guarantee what an AI assistant will say; we report what it said and fix what we can see.
        </p>
      </div>
    </section>
  );
}
