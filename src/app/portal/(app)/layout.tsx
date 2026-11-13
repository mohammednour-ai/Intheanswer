import Link from "next/link";
import type { Metadata } from "next";
import { requireOwner } from "@/lib/auth";
import { getSettings, effectiveDryRun } from "@/lib/settings";
import { countWaiting } from "@/lib/portal/queries";
import styles from "./portal.module.css";
import { markSvg } from "@/lib/brand";

export const metadata: Metadata = { title: "Portal", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const NAV = [
  { href: "/portal", label: "Queue" },
  { href: "/portal/held", label: "Held" },
  { href: "/portal/sent", label: "Sent" },
  { href: "/portal/replies", label: "Replies" },
  { href: "/portal/pages", label: "Pages" },
  { href: "/portal/mail", label: "Mail" },
  { href: "/portal/channels", label: "Channels" },
  { href: "/portal/overview", label: "Overview" },
  { href: "/portal/settings", label: "Settings" },
];

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const owner = await requireOwner();
  const s = await getSettings();
  const dry = await effectiveDryRun(s);
  const waiting = await countWaiting();
  return (
    <div className={styles.shell}>
      {s.kill_switch && <div className="banner banner-bad" role="status">Kill switch is on. Nothing is being sent.</div>}
      {s.auto_paused && (
        <div className="banner banner-bad" role="status">Sending auto-paused: {s.auto_pause_reason}</div>
      )}
      {s.pipeline_paused_for_spend && (
        <div className="banner banner-warn" role="status">Pipeline paused: daily Claude spend cap reached.</div>
      )}
      {dry && <div className="banner banner-warn" role="status">Dry run. Nothing is sent and nothing is charged.</div>}
      <header className={styles.header}>
        <div className="wrap row" style={{ justifyContent: "space-between" }}>
          <Link href="/portal" className={styles.brand}>
            <span dangerouslySetInnerHTML={{ __html: markSvg({ width: 24 }) }} />
            In The Answer
          </Link>
          <span className="small muted">{owner.email}{owner.devBypass ? " (dev)" : ""}</span>
        </div>
        <nav className="wrap" aria-label="Portal">
          <ul className={styles.nav}>
            {NAV.map((n) => (
              <li key={n.href}>
                <Link href={n.href}>
                  {n.label}
                  {n.href === "/portal" && waiting > 0 ? <span className="pill pill-blue" style={{ marginLeft: 6 }}>{waiting}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="wrap" style={{ paddingTop: 16, paddingBottom: 48 }}>{children}</main>
    </div>
  );
}
