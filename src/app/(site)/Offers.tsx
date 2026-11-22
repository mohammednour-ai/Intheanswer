import Link from "next/link";
import { priceNote } from "@/lib/env";
import { NEVER_PROMISED, REPORT_CREDIT_TEXT, TIERS, cad, priceText, termText, tierIncludes, type Switches, type TierKey } from "@/lib/offer";
import styles from "./site.module.css";

/** The three monthly plans, in order. The one-time report is stated under them. */
const PLANS: TierKey[] = ["visibility", "growth", "transformation"];
/** The plan drawn as the ink card. */
const MAIN: TierKey = "growth";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The amount set large on a card. */
const figure = (key: TierKey) => cad(TIERS[key].oneTimeCents ?? TIERS[key].monthlyCents);

/** What follows the amount in the published price: "a month", "a month, plus 500 CAD setup", "one time". */
const afterFigure = (key: TierKey) => priceText(key).replace(/^from\s+/, "").replace(figure(key), "").replace(/^[\s,]+/, "");

/** Twelve cells, the first `months` filled: how long each plan commits you, at a glance. */
function Meter({ months }: { months: number }) {
  return (
    <span className={styles.meter} aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <span key={i} className={i < months ? styles.on : undefined} />
      ))}
    </span>
  );
}

/**
 * The plans, read from src/lib/offer.ts: three cards whose rows line up (price, who does the work,
 * commitment, retests, what is included), then the one-time report on one line under them.
 * Growth is the ink card; only "We do the work for you" is blue. `switches` is the owner's choice
 * of what is offered (see switches.ts): lines of a pillar that is switched off are left out.
 */
export function Offers({
  switches,
  heading = "Three plans, each building on the last",
  eyebrow = "What does it cost?",
  headingLevel = 2,
}: {
  switches: Switches;
  heading?: string;
  eyebrow?: string;
  headingLevel?: 2 | 3;
}) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const Name = headingLevel === 2 ? "h3" : "h4";
  const report = TIERS.report;
  return (
    <section className={`${styles.band} ${styles.bandRule}`} aria-labelledby="plans-h">
      <div className={`${styles.container} ${styles.stack}`}>
        <div className={styles.split}>
          <div className={styles.headCol}>
            <span className={styles.eyebrow}>{eyebrow}</span>
            <H id="plans-h" className={styles.h2}>{heading}</H>
          </div>
          <div>
            <p className={styles.body2} style={{ margin: 0 }}>
              Each plan includes the one before it. The cards state the price, the term and the work on the same lines.
            </p>
            <ul className={styles.glance} aria-label="The plans in brief">
              {PLANS.map((k) => (
                <li key={k}><strong>{TIERS[k].name}: {priceText(k)}</strong><span>{TIERS[k].whoDoesIt}. {cap(termText(k))}.</span></li>
              ))}
            </ul>
          </div>
        </div>

        <div className={styles.plans}>
          {PLANS.map((k) => {
            const t = TIERS[k];
            const weDo = t.whoDoesIt.startsWith("We ");
            return (
              <article key={k} className={k === MAIN ? `${styles.plan} ${styles.planMain}` : styles.plan}>
                <div className={styles.planHead}>
                  <Name className={styles.planName}>{t.name}</Name>
                  <p className={styles.planPrice}>{t.priceFrom ? <span className={styles.planFrom}>from </span> : null}{figure(k)}</p>
                  <p className={styles.planSub}>{afterFigure(k)}</p>
                </div>
                <dl className={`${styles.planRow} ${styles.planRowFirst}`}>
                  <dt>Who does the work</dt>
                  <dd className={weDo ? undefined : styles.planValue}>{weDo ? <span className={styles.weDo}>{t.whoDoesIt}</span> : t.whoDoesIt}</dd>
                </dl>
                <dl className={styles.planRow}>
                  <dt>How long you commit</dt>
                  <dd><Meter months={t.minTermMonths ?? 0} /><span className={styles.planValue}>{cap(termText(k))}</span></dd>
                </dl>
                <dl className={styles.planRow}><dt>Retests</dt><dd className={styles.planRetest}>{t.retests}</dd></dl>
                <ul className={styles.planList}>
                  {tierIncludes(k, switches).map((line) => <li key={line}>{line}</li>)}
                </ul>
              </article>
            );
          })}
        </div>

        <div className={styles.planAlso}>
          <div className={styles.planAlsoHead}>
            <Name className={styles.planName}>Or one time</Name>
            <p className={styles.planAlsoName}>{report.name}: {priceText("report")}</p>
          </div>
          <p className={styles.planAlsoText}>{report.summary} {report.retests}. {REPORT_CREDIT_TEXT}</p>
        </div>

        <div className={styles.actions}>
          <Link className={styles.btnPrimary} href="/#get-report">Start with the free report</Link>
          <Link className={styles.btnOutline} href="/pricing#questions">
            Contract, cancelling and refunds
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
          </Link>
          <p className={styles.actionsNote}>
            Every plan starts in the same place. You read your free report first, and buy from it only if you want to. {TIERS.transformation.name} is quoted after a review.
          </p>
        </div>
        <p className={`${styles.fine} ${styles.fineRuled}`}>
          {priceNote()} {NEVER_PROMISED}
        </p>
      </div>
    </section>
  );
}
