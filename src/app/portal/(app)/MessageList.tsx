import Link from "next/link";
import type { QueueItem } from "@/lib/portal/queries";
import styles from "./portal.module.css";

const TYPE_LABEL: Record<string, string> = {
  first_email: "First email",
  follow_up: "Follow-up",
  interested_reply: "Reply: interested",
  question_answer: "Answer to question",
  full_report_delivery: "Full report",
  monthly_report: "Monthly report",
  retest_upgrade: "Retest + upgrade",
  final_files: "Final files",
  self_serve_teaser: "Self-serve teaser",
};

export function typeLabel(t: string) {
  return TYPE_LABEL[t] ?? t;
}

export function MessageList({ items, empty }: { items: QueueItem[]; empty: string }) {
  if (!items.length) return <p className="muted">{empty}</p>;
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }} className="stack">
      {items.map((m) => {
        const flags = Array.isArray(m.flags) ? m.flags : [];
        return (
          <li key={m.id}>
            <Link href={`/portal/item/${m.id}`} className={`card ${styles.item}`}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{m.clinic_name ?? m.to_email}</strong>
                <span className="pill">{typeLabel(m.type)}</span>
              </div>
              <div className="small muted">
                {[m.city, m.sector, m.score ? `In the answer: ${m.score}` : null].filter(Boolean).join(" · ")}
              </div>
              <div style={{ marginTop: 6 }}>{m.subject}</div>
              <div className="row small" style={{ marginTop: 6 }}>
                {flags.length === 0 ? (
                  <span className="pill pill-ok">No flags</span>
                ) : (
                  <span className="pill pill-warn">
                    {flags.length} flag{flags.length > 1 ? "s" : ""}
                  </span>
                )}
                <span className="pill">{m.status.replace("_", " ")}</span>
                {m.review_reason && <span className="muted">{m.review_reason}</span>}
                {m.expires_at && (
                  <span className="muted">expires {new Date(m.expires_at).toLocaleDateString("en-CA")}</span>
                )}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
