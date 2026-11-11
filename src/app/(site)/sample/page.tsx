import type { Metadata } from "next";
import Link from "next/link";
import styles from "../site.module.css";

export const metadata: Metadata = {
  title: "Sample report",
  description: "A sample In The Answer report for an invented clinic, showing the score, the questions, the clinics named and three website findings.",
};

export default function Sample() {
  return (
    <section style={{ padding: "48px 0" }}>
      <h1>Sample report</h1>
      <p className={styles.lead}>
        <strong>This is a sample. The clinic, the other clinics named and the answers are invented</strong> to show the
        format. A real report uses your clinic&apos;s own results and names the assistant, the model and the date.
      </p>
      <p><a href="/sample-report" target="_blank" rel="noreferrer">Open the sample in its own tab</a> · <Link href="/#get-report">Get your own free report</Link></p>
      <iframe className={styles.frame} src="/sample-report" title="Sample report for an invented clinic" />
    </section>
  );
}
