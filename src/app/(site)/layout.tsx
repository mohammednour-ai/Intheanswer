import Link from "next/link";
import { ownerDetails } from "@/lib/env";
import { markSvg } from "@/lib/brand";
import styles from "./site.module.css";

const NAV = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/sample", label: "Sample report" },
  { href: "/contact", label: "Contact" },
];

/** Structured data for our own site, built only from the owner details. */
function orgJsonLd() {
  const o = ownerDetails();
  return {
    "@context": "https://schema.org",
    "@type": "ProfessionalService",
    name: "In The Answer",
    legalName: o.businessName,
    url: "https://intheanswer.ca",
    email: o.email,
    telephone: o.phone,
    address: o.mailingAddress,
    areaServed: { "@type": "AdministrativeArea", name: "Ontario, Canada" },
    founder: { "@type": "Person", name: o.name },
    knowsLanguage: "en",
    priceRange: "200 CAD one time, or 200 CAD per month",
    openingHours: "Mo-Fr 09:00-17:00",
    description:
      "In The Answer tests whether AI assistants name an Ontario clinic when patients ask for a recommendation, reports what was found on the clinic's website, and fixes it.",
  };
}

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  const o = ownerDetails();
  return (
    <>
      <a href="#main" className="sr-only">Skip to content</a>
      <header className={styles.header}>
        <div className={`wrap ${styles.bar}`}>
          <Link href="/" className={styles.brand}>
            <span dangerouslySetInnerHTML={{ __html: markSvg({ width: 30 }) }} />
            In The Answer
          </Link>
          <nav aria-label="Main">
            <ul className={styles.nav}>
              {NAV.map((n) => (
                <li key={n.href}><Link href={n.href}>{n.label}</Link></li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main id="main" className="wrap">{children}</main>
      <footer className={styles.footer}>
        <div className="wrap">
          <p>
            <strong>In The Answer</strong> is run by {o.name}, {o.businessName.replace(/\.$/, "")}.<br />
            {o.mailingAddress} · <a href={`tel:${o.phone.replace(/[^+\d]/g, "")}`}>{o.phone}</a> · <a href={`mailto:${o.email}`}>{o.email}</a>
          </p>
          <p>Hours: Monday to Friday, 9:00 am to 5:00 pm (Toronto time). Service in English. Serving clinics across Ontario.</p>
          <p>
            <Link href="/privacy">Privacy</Link> · <Link href="/unsubscribe">Unsubscribe</Link> · <Link href="/bot">About our crawler</Link> · <Link href="/contact">Contact</Link>
          </p>
        </div>
      </footer>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd()).replace(/</g, "\\u003c") }} />
    </>
  );
}
