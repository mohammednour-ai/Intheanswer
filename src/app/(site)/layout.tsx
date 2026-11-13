import Link from "next/link";
import { ownerDetails } from "@/lib/env";
import { markSvg } from "@/lib/brand";
import styles from "./site.module.css";
import { NavLinks } from "./NavLinks";

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
    priceRange: "200 CAD one time, or from 50 CAD per month",
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
        <div className={`${styles.container} ${styles.bar}`}>
          <Link href="/" className={styles.brand}>
            <span dangerouslySetInnerHTML={{ __html: markSvg({ width: 30 }) }} />
            In The Answer
          </Link>
          <nav aria-label="Main" className={styles.navWrap}>
            <ul className={styles.nav}>
              <NavLinks items={NAV} />
            </ul>
          </nav>
          <Link href="/#get-report" className={styles.headerCta}>Free report</Link>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className={styles.footer}>
        <div className={`${styles.container} ${styles.footerGrid}`}>
          <div className={styles.footerWho}>
            <div className={styles.footerBrand}>
              <span dangerouslySetInnerHTML={{ __html: markSvg({ width: 30 }) }} />
              In The Answer
            </div>
            <p>In The Answer is run by {o.name}, {o.businessName.replace(/\.$/, "")}.</p>
            <p>
              {o.mailingAddress} · <a href={`tel:${o.phone.replace(/[^+\d]/g, "")}`}>{o.phone}</a> · <a href={`mailto:${o.email}`}>{o.email}</a>
            </p>
            <p>Hours: Monday to Friday, 9:00 am to 5:00 pm (Toronto time). Service in English. Serving clinics across Ontario.</p>
          </div>
          <nav aria-label="Footer" className={styles.footerNav}>
            <ul>
              <li><Link href="/how-it-works">How it works</Link></li>
              <li><Link href="/privacy">Privacy</Link></li>
              <li><Link href="/pricing">Pricing</Link></li>
              <li><Link href="/unsubscribe">Unsubscribe</Link></li>
              <li><Link href="/sample">Sample report</Link></li>
              <li><Link href="/bot">About our crawler</Link></li>
              <li><Link href="/contact">Contact</Link></li>
            </ul>
          </nav>
        </div>
      </footer>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd()).replace(/</g, "\\u003c") }} />
    </>
  );
}
