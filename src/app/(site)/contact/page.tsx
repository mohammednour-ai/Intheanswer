import type { Metadata } from "next";
import Link from "next/link";
import { ownerDetails } from "@/lib/env";
import styles from "../site.module.css";

export const metadata: Metadata = {
  title: "Contact",
  description: "Contact In The Answer by email or phone. Replies within one business day, Monday to Friday, Toronto time.",
};

export default function Contact() {
  const o = ownerDetails();
  return (
    <div className="wrap">
      <article className={styles.prose}>
      <h1>Contact</h1>
      <p>In The Answer is run by {o.name}, {o.businessName}.</p>
      <p>
        Email: <a href={`mailto:${o.email}`}>{o.email}</a><br />
        Phone: <a href={`tel:${o.phone.replace(/[^+\d]/g, "")}`}>{o.phone}</a><br />
        Mail: {o.mailingAddress}
      </p>
      <p>Hours: Monday to Friday, 9:00 am to 5:00 pm, Toronto time. We reply within one business day.</p>
      <h2>If you received a report from us</h2>
      <p>Reply to that email with any question. To stop all emails, use the link at the bottom of the email or the <Link href="/unsubscribe">unsubscribe page</Link>.</p>
    </article>
    </div>
  );
}
