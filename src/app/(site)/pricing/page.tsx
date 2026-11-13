import type { Metadata } from "next";
import { ownerDetails } from "@/lib/env";
import { Offers } from "../Offers";
import styles from "../site.module.css";

export const metadata: Metadata = {
  title: "Pricing",
  description: "The teaser report is free. The full report and fix files are 200 CAD one time. Monthly reports are 150 CAD for the first month, then 50 CAD per month. The full service plan is 200 CAD per month: website work, fixes installed, monthly retest.",
};

export default function Pricing() {
  const o = ownerDetails();
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
        <p>The one-time report has none. Monthly reports have a minimum term of {o.reportsMinTerm}. The full service plan is a {o.contractTerm} contract, because it includes work on your website that is spread over the year. Both are billed monthly by card.</p>
        <h3>What is the difference between monthly reports and the full service plan?</h3>
        <p>With monthly reports you get the findings and the fix files, and a fresh report each month; your own web person makes the changes. With the full service plan we make the changes: we renovate your website or take it over, install every fix, add new pages each month and keep the details current.</p>
        <h3>What does &ldquo;renovated or taken over&rdquo; mean?</h3>
        <p>If your site is sound, we repair and upgrade it where it stands. If it cannot be brought up to standard, we rebuild it and run it for you. Either way the domain name and the content stay yours, and we hand everything back if the plan ends.</p>
        <h3>What does the full service plan not include?</h3>
        <p>Advertising spend, photography, online booking or payment systems, and writing clinical content for you. Every clinical or pricing fact on your site is confirmed by you before it is published, and you are responsible for checking wording against your regulator&apos;s advertising rules.</p>
        <h3>Can I cancel or get a refund?</h3>
        <p>Write to us from the address you paid with. Refunds for the one-time report are given when the report has not yet been delivered. A monthly plan can be ended at any time after its minimum term or contract.</p>
      </section>
    </>
  );
}
