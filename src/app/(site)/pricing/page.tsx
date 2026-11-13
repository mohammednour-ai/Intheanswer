import type { Metadata } from "next";
import Link from "next/link";
import { ownerDetails } from "@/lib/env";
import { Offers } from "../Offers";
import site from "../site.module.css";
import styles from "./pricing.module.css";

export const metadata: Metadata = {
  title: "Pricing",
  description: "The teaser report is free. The full report and fix files are 200 CAD one time. Monthly reports are 150 CAD for the first month, then 50 CAD per month. The full service plan is 200 CAD per month: website work, fixes installed, monthly retest.",
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Cross() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12" /><path d="M18 6L6 18" />
    </svg>
  );
}

export default function Pricing() {
  const o = ownerDetails();
  const contract = `${o.contractTerm} contract`;
  return (
    <>
      <section className={styles.hero} aria-labelledby="hero-h">
        <div className={`${site.container} ${styles.heroRow}`}>
          <div className={styles.heroMain}>
            <span className={site.eyebrow}>Pricing</span>
            <h1 id="hero-h" className={styles.h1}>
              What it costs, and <span className={styles.accent}>what you commit to.</span>
            </h1>
          </div>
          <div className={styles.heroSide}>
            <p className={styles.heroLead}>The first report is free. It shows your result for each question, the clinics named, and three findings from your website.</p>
            <div className={site.actions}>
              <Link className={site.btnPrimary} href="/#get-report">Start with the free report</Link>
              <Link className={styles.textLink} href="/sample">See a sample report</Link>
            </div>
          </div>
        </div>
      </section>

      <Offers heading="Paid options" eyebrow="After the free report" />

      <section id="questions" className={`${site.band} ${site.bandSoft}`} aria-labelledby="faq-h">
        <div className={`${site.container} ${site.stack}`}>
          <div className={styles.sectionHead}>
            <span className={site.eyebrow}>Contracts, cancelling and refunds</span>
            <h2 id="faq-h" className={site.h2}>Questions about price</h2>
          </div>

          <div className={styles.qs}>
            <div className={styles.q}>
              <div className={styles.qHead}>
                <span className={styles.qNum} aria-hidden="true">1</span>
                <h3 className={styles.qTitle}>Is there a contract?</h3>
              </div>
              <div className={styles.qBody}>
                <ul className={styles.table}>
                  <li><span className={styles.rowName}>One-time report</span><span className={styles.rowVal}>None</span></li>
                  <li><span className={styles.rowName}>Monthly reports</span><span className={styles.rowVal}>Minimum term of {o.reportsMinTerm}</span></li>
                  <li><span className={styles.rowName}>Full service plan</span><span className={styles.rowVal}>{cap(contract)}</span></li>
                </ul>
                <p className={styles.note}>The full service plan is a {contract}, because it includes work on your website that is spread over the year. Both monthly plans are billed monthly by card.</p>
              </div>
            </div>

            <div className={styles.q}>
              <div className={styles.qHead}>
                <span className={styles.qNum} aria-hidden="true">2</span>
                <h3 className={styles.qTitle}>What is the difference between monthly reports and the full service plan?</h3>
              </div>
              <div className={styles.qBody}>
                <div className={styles.pair}>
                  <div className={styles.tile}>
                    <span className={styles.tileLabel}>Monthly reports</span>
                    <span className={styles.tileHead}>Your own web person makes the changes.</span>
                    <span className={styles.tileText}>You get the findings and the fix files, and a fresh report each month.</span>
                  </div>
                  <div className={`${styles.tile} ${styles.tileInk}`}>
                    <span className={styles.tileLabel}>Full service plan</span>
                    <span className={styles.tileHead}>We make the changes.</span>
                    <span className={styles.tileText}>We renovate your website or take it over, install every fix, add new pages each month and keep the details current.</span>
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.q}>
              <div className={styles.qHead}>
                <span className={styles.qNum} aria-hidden="true">3</span>
                <h3 className={styles.qTitle}>What does &ldquo;renovated or taken over&rdquo; mean?</h3>
              </div>
              <div className={styles.qBody}>
                <div className={styles.pair}>
                  <div className={styles.tile}>
                    <span className={styles.tileLabel}>If your site is sound</span>
                    <span className={styles.tilePlain}>We repair and upgrade it where it stands.</span>
                  </div>
                  <div className={styles.tile}>
                    <span className={styles.tileLabel}>If it cannot be brought up to standard</span>
                    <span className={styles.tilePlain}>We rebuild it and run it for you.</span>
                  </div>
                </div>
                <p className={styles.check}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
                  <span>Either way the domain name and the content stay yours, and we hand everything back if the plan ends.</span>
                </p>
              </div>
            </div>

            <div className={styles.q}>
              <div className={styles.qHead}>
                <span className={styles.qNum} aria-hidden="true">4</span>
                <h3 className={styles.qTitle}>What does the full service plan not include?</h3>
              </div>
              <div className={styles.qBody}>
                <ul className={styles.chips}>
                  <li><Cross />Advertising spend</li>
                  <li><Cross />Photography</li>
                  <li><Cross />Online booking or payment systems</li>
                  <li><Cross />Writing clinical content for you</li>
                </ul>
                <p className={styles.note}>Every clinical or pricing fact on your site is confirmed by you before it is published, and you are responsible for checking wording against your regulator&rsquo;s advertising rules.</p>
              </div>
            </div>

            <div className={styles.q}>
              <div className={styles.qHead}>
                <span className={styles.qNum} aria-hidden="true">5</span>
                <h3 className={styles.qTitle}>Can I cancel or get a refund?</h3>
              </div>
              <div className={styles.qBody}>
                <p className={styles.strong}>Write to us from the address you paid with.</p>
                <ul className={`${styles.table} ${styles.tableStacked}`}>
                  <li><span className={styles.rowName}>One-time report</span><span className={styles.rowVal}>Refunds are given when the report has not yet been delivered.</span></li>
                  <li><span className={styles.rowName}>Monthly reports and the full service plan</span><span className={styles.rowVal}>A monthly plan can be ended at any time after its minimum term or contract.</span></li>
                </ul>
                <a className={styles.mail} href={`mailto:${o.email}`}>{o.email}</a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={site.band} aria-labelledby="close-h">
        <div className={`${site.container} ${styles.closeRow}`}>
          <div className={styles.closeMain}>
            <h2 id="close-h" className={styles.closeH2}>Three lines in an answer. See which one is yours.</h2>
            <p className={styles.closeLead}>Recommended, listed only, or not named: the free report shows the result for each question, the clinics named, and three findings from your website.</p>
            <div className={site.actions}>
              <Link className={site.btnPrimary} href="/#get-report">Get your clinic&rsquo;s free report</Link>
              <Link className={styles.textLink} href="/sample">See a sample report</Link>
            </div>
          </div>
          <div className={styles.bars} aria-hidden="true">
            <span className={`${styles.bar} ${styles.barTop}`} />
            <span className={`${styles.bar} ${styles.barYou}`}>Your clinic?</span>
            <span className={`${styles.bar} ${styles.barBottom}`} />
          </div>
        </div>
      </section>
    </>
  );
}
