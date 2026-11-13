import type { Metadata } from "next";
import Link from "next/link";
import { ownerDetails } from "@/lib/env";
import styles from "../site.module.css";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What In The Answer collects, why, how long it is kept, and how to stop emails or have information removed.",
};

export default function Privacy() {
  const o = ownerDetails();
  return (
    <div className="wrap">
      <article className={styles.prose}>
      <h1>Privacy</h1>
      <p>In The Answer is run by {o.name}, {o.businessName}, {o.mailingAddress}. Questions about this page: <a href={`mailto:${o.email}`}>{o.email}</a>.</p>

      <h2>What we collect about clinics</h2>
      <ul>
        <li><strong>Public website content.</strong> We read pages of a clinic&apos;s own public website and keep copies so each report can show its evidence. Our crawler respects robots.txt.</li>
        <li><strong>A business contact address.</strong> Only an email address the clinic publishes on its own website, with the page where it appears. We do not buy lists, guess addresses or take them from directories.</li>
        <li><strong>AI assistant answers.</strong> The questions we asked, the answers and the sources the assistant cited.</li>
        <li><strong>Report views.</strong> Whether a report link was opened, and a count. No advertising trackers.</li>
        <li><strong>What you send us.</strong> Replies, forms you complete, and details needed to deliver a paid service. Card payments are handled by Stripe; we do not see or store card numbers.</li>
      </ul>
      <p>We do not collect patient information. If you connect your Google Business Profile as a client, we read your own reviews to count them and summarise themes; we do not store review text, reviewer names or any health detail.</p>

      <h2>Google Maps content</h2>
      <p>Some reports show ratings and review counts from Google Maps. These are fetched when the report is opened and are not stored by us. Use of Google Maps content is subject to the <a href="https://cloud.google.com/maps-platform/terms" rel="noreferrer">Google Maps Platform Terms of Service</a> and the <a href="https://policies.google.com/privacy" rel="noreferrer">Google Privacy Policy</a>.</p>

      <h2>Why we email clinics</h2>
      <p>We send a clinic its report because the address is published by the clinic for business contact and the report is about that clinic&apos;s business. We write at most twice unless you reply. Every email names the sender, gives a mailing address and has an unsubscribe link that works at once without a login. We do not write to clinics whose site says not to send solicitations.</p>

      <h2>How to stop emails or remove information</h2>
      <p>Use the link in any email or the <Link href="/unsubscribe">unsubscribe page</Link>. To have your clinic&apos;s report and stored pages deleted, email <a href={`mailto:${o.email}`}>{o.email}</a>. We keep only the address on a do-not-contact list so we do not write again.</p>

      <h2>How long we keep things</h2>
      <p>Reports and their evidence are kept while a clinic is a client or may still read its report, and deleted on request. Do-not-contact records are kept so that they keep working.</p>

      <h2>Service providers</h2>
      <p>We use hosting, database, email, payment and AI providers to run the service. They process information for us under their own terms and may store it outside Canada.</p>
    </article>
    </div>
  );
}
