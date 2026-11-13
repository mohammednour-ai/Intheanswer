import Link from "next/link";
import { markSvg } from "@/lib/brand";
import { ownerDetails } from "@/lib/env";
import site from "../(site)/site.module.css";
import s from "./buy.module.css";

/**
 * Plain frame for the checkout and intake pages: the brand, the content, who we are.
 * No site navigation, so nothing pulls a buyer away mid-checkout. `wide` is the two-column
 * checkout; everything else (other checkout states, intake) reads in one narrow column.
 */
export function Shell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  const o = ownerDetails();
  return (
    <>
      <header className={site.header}>
        <div className={`${site.container} ${s.headBar}`}>
          <Link href="/" className={site.brand}>
            <span className={s.mark} dangerouslySetInnerHTML={{ __html: markSvg({ width: 30 }) }} />
            In The Answer
          </Link>
        </div>
      </header>
      <main className={s.main}>
        <div className={`${site.container} ${s.content}${wide ? "" : ` ${s.narrow}`}`}>{children}</div>
      </main>
      <footer className={s.footer}>
        <div className={`${site.container} ${s.footIn}`}>
          <div className={s.footText}>
            <p>In The Answer is run by {o.name}, {o.businessName}.</p>
            <p>
              {o.mailingAddress} · {o.phone} · <a href={`mailto:${o.email}`}>{o.email}</a>
            </p>
          </div>
          <nav aria-label="Footer">
            <ul className={s.footNav}>
              <li><Link href="/privacy">Privacy</Link></li>
              <li><Link href="/contact">Contact</Link></li>
            </ul>
          </nav>
        </div>
      </footer>
    </>
  );
}
