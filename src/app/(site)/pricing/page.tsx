import type { Metadata } from "next";
import { Offers } from "../Offers";
import styles from "../site.module.css";

export const metadata: Metadata = {
  title: "Pricing",
  description: "The teaser report is free. The full report and fix files are 200 CAD one time. The monthly plan is 200 CAD per month: website work, fixes installed, monthly retest.",
};

export default function Pricing() {
  return (
    <>
      <div style={{ padding: "48px 0 8px" }} className={styles.prose}>
        <h1>Pricing</h1>
        <p className={styles.lead}>The first report is free. It shows your result for each question, the clinics named, and three findings from your website.</p>
      </div>
      <Offers heading="Paid options" />
      <section className={styles.section}>
        <h2>Questions about price</h2>
        <h3>Is there a contract?</h3>
        <p>The one-time report has none. The monthly plan has a minimum term, shown above, and is billed monthly by card.</p>
        <h3>What does the monthly plan not include?</h3>
        <p>Advertising spend, photography, and writing clinical content for you. Every clinical or pricing fact on your site is confirmed by you before it is published, and you are responsible for checking wording against your regulator&apos;s advertising rules.</p>
        <h3>Can I cancel or get a refund?</h3>
        <p>Write to us from the address on your account. Refunds for the one-time report are given when the report has not yet been delivered.</p>
      </section>
    </>
  );
}
