import type { Metadata } from "next";
import Link from "next/link";
import styles from "../site.module.css";

export const metadata: Metadata = {
  title: "How it works",
  description: "How In The Answer tests AI assistants with patient questions, checks a clinic's website, and verifies every claim before a report is sent.",
};

export default function HowItWorks() {
  return (
    <article className={styles.prose} style={{ padding: "48px 0" }}>
      <h1>How it works</h1>
      <h2>What do you test?</h2>
      <p>We put five or six questions to an AI assistant with web search turned on, located in your city. The questions are written the way a patient asks, for example &ldquo;Which dentists in Barrie can see me the same day for a dental emergency?&rdquo; The assistant is not told about your clinic.</p>
      <h2>What do you record?</h2>
      <p>The full answer to each question, the sources it used, and every clinic it named. For your clinic, each question gets one of three results: <strong>recommended</strong> (put forward as an option), <strong>listed only</strong> (mentioned or cited without being recommended), or <strong>not named</strong>. Every report names the assistant, the model and the date.</p>
      <h2>What do you check on my website?</h2>
      <p>Whether the facts patients ask about are stated in text: new-patient status, hours (and whether two sets disagree), fees for uninsured services, insurance and direct billing, practitioner names and credentials, languages, and areas served. We also test the site itself: the path to booking, layout and speed on a phone, broken links, whether AI crawlers are allowed, and an automated accessibility scan (automated checks, not a full accessibility audit).</p>
      <h2>How do I know the report is accurate?</h2>
      <p>Every finding is tied to stored evidence: the answer text or the page where it was seen. A separate verification pass rereads each sentence against that evidence before anything is sent, and removes any claim it cannot match. When something could not be checked, the report says &ldquo;not detected&rdquo; or &ldquo;could not test&rdquo;. It is never presented as a problem.</p>
      <h2>What are the limits?</h2>
      <p>A report is a snapshot: one assistant, a handful of questions, one day. Assistants change what they say, and results differ between assistants and apps. No one can guarantee that a clinic will be named, and we do not promise it.</p>
      <h2>How did you get my email address?</h2>
      <p>We only write to an address a clinic publishes on its own website, and each email names the page where we found it. We write at most twice. Every email has an <Link href="/unsubscribe">unsubscribe link</Link> that works at once, without a login. If your site says not to send solicitations, we do not write.</p>
      <h2>What happens if I buy?</h2>
      <p>With the one-time report you receive every finding and the fix files, a short form for the facts only you know, and a retest four weeks later. With monthly reports you get the same report and files, then an updated report every month. With the full service plan we renovate your site or take it over, install the fixes, add two answer pages a month for your approval, and retest every month. See <Link href="/pricing">pricing</Link>.</p>
      <p><Link className="btn btn-primary" href="/#get-report">Get your free report</Link></p>
    </article>
  );
}
