import type { Metadata } from "next";
import Link from "next/link";
import { ownerDetails } from "@/lib/env";
import { PILLARS, PROMISES, REPORT_CREDIT_TEXT, TIERS, TIER_ORDER, priceText, termText, type TierKey } from "@/lib/offer";
import { Offers } from "../Offers";
import { Promises } from "../Promises";
import { ClosingBand } from "../ClosingBand";
import { Banner } from "../Banner";
import { siteSwitches } from "../switches";
import site from "../site.module.css";
import styles from "./pricing.module.css";
import bannerReception from "../images/banner-reception.jpg";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The three monthly plans, for the questions that compare them. */
const PLANS: TierKey[] = ["visibility", "growth", "transformation"];

export const metadata: Metadata = {
  title: "Pricing",
  // every amount comes from src/lib/offer.ts, so this line cannot fall behind the cards
  description: `The first report is free. ${PLANS.map((k) => `${TIERS[k].name} is ${priceText(k)}`).join(". ")}. ${TIERS.report.name}: ${priceText("report")}.`,
};

/** The page is rebuilt at most every ten minutes, so a change to the offer switches in the portal shows soon after. */
export const revalidate = 600;

function Cross() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12" /><path d="M18 6L6 18" />
    </svg>
  );
}

export default async function Pricing() {
  const o = ownerDetails();
  const switches = await siteSwitches();
  const on = (key: keyof typeof PROMISES) => switches.promises.includes(key);
  const website = switches.pillars.includes("website");
  return (
    <>
      <Banner id="hero-h" photo={bannerReception} small>
        <span className={site.eyebrow}>Pricing</span>
        <h1 id="hero-h" className={site.h1}>
          What it costs, and <span className={site.accent}>what you commit to.</span>
        </h1>
        <p className={site.bannerLead}>The first report is free. It shows your result for each question, the clinics named, and three findings from your website.</p>
        <div className={site.actions}>
          <Link className={site.btnPrimary} href="/#get-report">Start with the free report</Link>
          <Link className={site.link} href="/sample">See a sample report</Link>
        </div>
      </Banner>

      <Offers switches={switches} heading="Plans" eyebrow="After the free report" />

      <Promises switches={switches} />

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
                  {TIER_ORDER.map((k) => (
                    <li key={k}><span className={styles.rowName}>{TIERS[k].name}</span><span className={styles.rowVal}>{cap(termText(k))}</span></li>
                  ))}
                </ul>
                <p className={styles.note}>
                  {TIERS.growth.name} and {TIERS.transformation.name} have a minimum term because they include work on your website and systems that is spread over months. Monthly plans are billed monthly by card.
                </p>
              </div>
            </div>

            <div className={styles.q}>
              <div className={styles.qHead}>
                <span className={styles.qNum} aria-hidden="true">2</span>
                <h3 className={styles.qTitle}>What is the difference between the plans?</h3>
              </div>
              <div className={styles.qBody}>
                <div className={styles.pair}>
                  {PLANS.map((k) => (
                    <div key={k} className={k === "growth" ? `${styles.tile} ${styles.tileInk}` : styles.tile}>
                      <span className={styles.tileLabel}>{TIERS[k].name}</span>
                      <span className={styles.tileHead}>{cap(priceText(k))}</span>
                      <span className={styles.tileText}>{TIERS[k].summary}</span>
                    </div>
                  ))}
                </div>
                <p className={styles.note}>{TIERS.report.name} ({priceText("report")}): {TIERS.report.summary} {REPORT_CREDIT_TEXT}</p>
              </div>
            </div>

            {website ? (
              <div className={styles.q}>
                <div className={styles.qHead}>
                  <span className={styles.qNum} aria-hidden="true">3</span>
                  <h3 className={styles.qTitle}>What does the website rebuild in {TIERS.growth.name} cover?</h3>
                </div>
                <div className={styles.qBody}>
                  <p className={styles.strong}>{PILLARS.website.text}</p>
                  {on("ownership") ? (
                    <p className={styles.check}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
                      <span>{PROMISES.ownership.text}</span>
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className={styles.q}>
              <div className={styles.qHead}>
                <span className={styles.qNum} aria-hidden="true">{website ? 4 : 3}</span>
                <h3 className={styles.qTitle}>What do the plans not include?</h3>
              </div>
              <div className={styles.qBody}>
                <ul className={styles.chips}>
                  <li><Cross />Advertising spend</li>
                  <li><Cross />Photography</li>
                  <li><Cross />Writing clinical content for you</li>
                </ul>
                <p className={styles.note}>Every clinical or pricing fact on your site is confirmed by you before it is published, and you are responsible for checking wording against your regulator&rsquo;s advertising rules.</p>
              </div>
            </div>

            <div className={styles.q}>
              <div className={styles.qHead}>
                <span className={styles.qNum} aria-hidden="true">{website ? 5 : 4}</span>
                <h3 className={styles.qTitle}>Can I cancel or get a refund?</h3>
              </div>
              <div className={styles.qBody}>
                <p className={styles.strong}>Write to us from the address you paid with.</p>
                <ul className={`${styles.table} ${styles.tableStacked}`}>
                  <li><span className={styles.rowName}>{TIERS.report.name}</span><span className={styles.rowVal}>Refunds are given when the report has not yet been delivered.</span></li>
                  <li>
                    <span className={styles.rowName}>Monthly plans</span>
                    <span className={styles.rowVal}>
                      {on("terms")
                        ? PROMISES.terms.text
                        : `${TIERS.visibility.name} is ${termText("visibility")}. ${TIERS.growth.name} and ${TIERS.transformation.name} have a ${termText("growth")}.`}
                    </span>
                  </li>
                  <li><span className={styles.rowName}>If you bought the report first</span><span className={styles.rowVal}>{REPORT_CREDIT_TEXT}</span></li>
                </ul>
                <a className={styles.mail} href={`mailto:${o.email}`}>{o.email}</a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <ClosingBand
        id="close-h"
        heading="Three lines in an answer. See which one is yours."
        lead="Recommended, listed only, or not named: the free report shows the result for each question, the clinics named, and three findings from your website."
      >
        <Link className={site.btnPrimary} href="/#get-report">Get your clinic&rsquo;s free report</Link>
        <Link className={site.link} href="/sample">See a sample report</Link>
      </ClosingBand>
    </>
  );
}
