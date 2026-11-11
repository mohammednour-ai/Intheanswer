import { notFound } from "next/navigation";
import Link from "next/link";
import { getMessage } from "@/lib/portal/queries";
import { typeLabel } from "../../MessageList";
import styles from "../../portal.module.css";
import { copilotAvatarSvg, COPILOT_NAME } from "@/lib/brand";
import {
  approveAction,
  editAndSendAction,
  regenerateAction,
  skipAction,
  neverContactAction,
} from "../../actions";

interface Evidence {
  kind: string;
  url?: string;
  quote?: string;
  label?: string;
}
interface Claim {
  claim: string;
  evidence: Evidence[];
  verified?: boolean;
}
interface Flag {
  code: string;
  message: string;
  severity: string;
}

export default async function ItemPage(props: PageProps<"/portal/item/[id]">) {
  const { id } = await props.params;
  const data = await getMessage(id);
  if (!data) notFound();
  const m = data.message;
  // the email repeats two report findings: show each claim once
  const claims = ((m.claims as Claim[]) ?? []).filter((c, i, all) => all.findIndex((x) => x.claim === c.claim) === i);
  const flags = (m.flags as Flag[]) ?? [];
  const actionable = ["pending_review", "held"].includes(m.status as string);

  return (
    <article className="stack">
      <p>
        <Link href="/portal">Back to queue</Link>
      </p>
      <header>
        <h1 style={{ marginBottom: 4 }}>{(m.clinic_name as string) ?? (m.to_email as string)}</h1>
        <div className="row small">
          <span className="pill">{typeLabel(m.type as string)}</span>
          <span className="pill">{String(m.status).replace("_", " ")}</span>
          <span className="muted">{[m.city, m.sector].filter(Boolean).join(" · ")}</span>
          {m.clinic_id ? (
            <>
              <Link href={`/portal/clinic/${m.clinic_id}?tab=reviews`}>Reviews</Link>
              <Link href={`/portal/clinic/${m.clinic_id}?tab=site`}>Site test</Link>
            </>
          ) : null}
          {m.website ? (
            <a href={m.website as string} rel="noreferrer" target="_blank">
              {m.domain as string}
            </a>
          ) : null}
        </div>
        {m.review_reason ? <p className="small muted">Why it is here: {m.review_reason as string}</p> : null}
      </header>

      <section className="card" aria-labelledby="flags-h">
        <div className="row" style={{ alignItems: "center", marginBottom: 8 }}>
          <span dangerouslySetInnerHTML={{ __html: copilotAvatarSvg({ size: 32, label: `${COPILOT_NAME} (AI)` }) }} />
          <h2 id="flags-h" style={{ fontSize: "1.1rem", margin: 0 }}>
            Verification gate <span className="small muted">· {COPILOT_NAME}</span>
          </h2>
        </div>
        {flags.length === 0 ? (
          <p className="pill pill-ok">No flags. Every claim matched stored evidence.</p>
        ) : (
          <ul>
            {flags.map((f, i) => (
              <li key={i}>
                <strong>{f.severity === "block" ? "Blocking" : "Warning"}:</strong> {f.message}{" "}
                <span className="muted small">({f.code})</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className={styles.grid2}>
        <section className="card" aria-labelledby="email-h">
          <h2 id="email-h" style={{ fontSize: "1.1rem" }}>
            Email exactly as it will be sent
          </h2>
          <div className={styles.kv}>
            <span className="muted">To</span>
            <span>{m.to_email as string}</span>
            {m.contact_source_url ? (
              <>
                <span className="muted">Address found at</span>
                <a href={m.contact_source_url as string} target="_blank" rel="noreferrer">
                  {m.contact_source_url as string}
                </a>
              </>
            ) : null}
            <span className="muted">Subject</span>
            <strong>{m.subject as string}</strong>
          </div>
          <pre style={{ marginTop: 12 }}>{m.body_text as string}</pre>
          {m.attach_pdf ? <p className="small muted">The report PDF is attached.</p> : null}
        </section>

        <section className="card" aria-labelledby="report-h">
          <h2 id="report-h" style={{ fontSize: "1.1rem" }}>
            Report preview
          </h2>
          {m.report_token ? (
            <>
              <iframe
                className={styles.preview}
                src={`/r/${m.report_token}?preview=owner`}
                title="Report preview"
              />
              <p className="small">
                <a href={`/r/${m.report_token}?preview=owner`} target="_blank" rel="noreferrer">
                  Open report
                </a>{" "}
                ·{" "}
                <a href={`/r/${m.report_token}/pdf?preview=owner`} target="_blank" rel="noreferrer">
                  PDF
                </a>
              </p>
            </>
          ) : (
            <p className="muted">No report attached to this message.</p>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="claims-h">
        <h2 id="claims-h" style={{ fontSize: "1.1rem" }}>
          Every claim and its evidence
        </h2>
        {claims.length === 0 ? (
          <p className="muted">This message makes no factual claims about the clinic.</p>
        ) : (
          <ol className={styles.claims}>
            {claims.map((c, i) => (
              <li key={i}>
                <div className={styles.claim}>
                  {c.claim}
                  {c.verified === false ? <span className="pill pill-bad"> no matching evidence</span> : null}
                </div>
                <ul className={styles.evidence}>
                  {c.evidence.map((e, j) => (
                    <li key={j}>
                      {e.kind === "pages_read" ? <strong>Pages read: </strong> : null}
                      {e.label ? <strong>{e.label}</strong> : null}
                      {e.label && (e.quote || e.url) ? ": " : null}
                      {e.quote ? <q>{e.quote}</q> : null}{" "}
                      {e.url ? (
                        <a href={e.url} target="_blank" rel="noreferrer">
                          {e.url}
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>

      {actionable ? (
        <section className="card stack" aria-labelledby="act-h">
          <h2 id="act-h" style={{ fontSize: "1.1rem" }}>
            Actions
          </h2>
          <p className="small muted">Sending is not built yet (phase 4). Approving records your decision and holds the item; nothing is sent.</p>
          <div className="row">
            <form action={approveAction.bind(null, id)}>
              <button className="btn btn-primary">Approve and send</button>
            </form>
            <form action={regenerateAction.bind(null, id)}>
              <button className="btn">Regenerate</button>
            </form>
            <form action={skipAction.bind(null, id)}>
              <button className="btn">Skip this clinic</button>
            </form>
            <form action={neverContactAction.bind(null, id)}>
              <button className="btn btn-danger">Never contact</button>
            </form>
          </div>
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 600, minHeight: 44, display: "flex", alignItems: "center" }}>
              Edit then send
            </summary>
            <form action={editAndSendAction.bind(null, id)} className="stack">
              <div>
                <label htmlFor="subject">Subject</label>
                <input id="subject" name="subject" type="text" defaultValue={m.subject as string} required />
              </div>
              <div>
                <label htmlFor="body">Body</label>
                <textarea id="body" name="body" defaultValue={m.body_text as string} rows={16} required />
              </div>
              <p className="small muted">
                Your edits must keep the unsubscribe link and pass the wording rules. Your edits are saved and logged. Sending rules (caps, suppression, hours) still apply.
              </p>
              <button className="btn btn-primary">Save edit and send</button>
            </form>
          </details>
        </section>
      ) : null}

      <section aria-labelledby="log-h">
        <h2 id="log-h" style={{ fontSize: "1.1rem" }}>
          History
        </h2>
        {data.log.length === 0 && data.events.length === 0 ? (
          <p className="muted small">No actions yet.</p>
        ) : (
          <ul className="small">
            {data.log.map((l) => (
              <li key={String(l.id)}>
                {new Date(l.at as Date).toLocaleString("en-CA", { timeZone: "America/Toronto" })}:{" "}
                {l.action as string} by {(l.actor_email as string) ?? "system"}
              </li>
            ))}
            {data.events.map((e, i) => (
              <li key={`e${i}`}>
                {new Date(e.occurred_at as Date).toLocaleString("en-CA", { timeZone: "America/Toronto" })}:{" "}
                {e.type as string}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
