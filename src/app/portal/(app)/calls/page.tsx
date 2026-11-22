import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { getSettings, effectiveDryRun } from "@/lib/settings";
import { COPILOT_NAME, copilotAvatarSvg } from "@/lib/brand";
import { listCalls, listCallSuppressions, turnsFor, type CallListItem } from "@/lib/calls/queries";
import { callsReady } from "@/lib/calls/rules";
import { OWNER_SOURCES } from "@/lib/calls/request";
import { displayPhone } from "@/lib/calls/phone";
import { addCallSuppressionAction, cancelCallAction } from "./actions";

const STATUS: Record<string, { t: string; cls: string }> = {
  queued: { t: "Queued", cls: "pill-blue" },
  dialing: { t: "Dialling", cls: "pill-blue" },
  in_progress: { t: "On the call", cls: "pill-blue" },
  completed: { t: "Completed", cls: "pill-ok" },
  no_answer: { t: "No answer", cls: "" },
  busy: { t: "Busy", cls: "" },
  voicemail: { t: "Answering machine", cls: "" },
  failed: { t: "Failed", cls: "pill-bad" },
  cancelled: { t: "Cancelled", cls: "" },
  blocked: { t: "Not placed", cls: "pill-warn" },
};

const OUTCOME: Record<string, string> = {
  interested: "Interested",
  wants_person: "Wants a person",
  asked_questions: "Asked questions",
  not_interested: "Not interested",
  no_contact_wanted: "Asked for no contact",
  no_conversation: "Nobody spoke",
  wrong_number: "Wrong number",
  unavailable: "Assistant was off",
  dry_run: "Dry run",
  other: "Other",
};

const when = (d: Date | null) => (d ? new Date(d).toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" }) : "");

function consentLine(c: CallListItem): string {
  if (c.direction === "inbound") return "They phoned us.";
  if (!c.consent_source) return "No request on record.";
  if (c.consent_source === "web_form") return `Asked for on the report page, ${when(c.consent_at)}.`;
  const how = OWNER_SOURCES[c.consent_source as keyof typeof OWNER_SOURCES] ?? c.consent_source;
  return `The clinic ${how} (${when(c.consent_at)}). Your note: ${c.consent_note ?? ""}`;
}

export default async function CallsPage(props: PageProps<"/portal/calls">) {
  await requireOwner();
  const sp = await props.searchParams;
  const s = await getSettings();
  const dry = await effectiveDryRun(s);
  const ready = callsReady();
  const calls = await listCalls();
  const turns = await turnsFor(calls.map((c) => c.id));
  const dnc = await listCallSuppressions();

  return (
    <section className="stack">
      <div className="row" style={{ alignItems: "center" }}>
        <span dangerouslySetInnerHTML={{ __html: copilotAvatarSvg({ size: 32, label: `${COPILOT_NAME} (AI)` }) }} />
        <h1 style={{ margin: 0 }}>Calls</h1>
      </div>
      <p className="muted">
        {COPILOT_NAME} explains a clinic&apos;s report by phone and answers questions about the paid options. It only calls a number a
        clinic asked us to call, and it answers calls made to our number. Every call is transcribed and checked afterwards against the
        report it was given.
      </p>
      <p className="small">
        Calls are <strong>{s.calls_enabled ? "on" : "off"}</strong>
        {ready.ok ? "" : ` · not set up yet: ${ready.missing.join("; ")}`}
        {dry ? " · dry run: no call is placed" : ""} · <Link href="/portal/settings#calls-h">Settings</Link>
      </p>

      {calls.length === 0 ? (
        <p className="muted">No calls yet. A call appears here when a clinic asks for one on its report page, when you schedule one from a clinic&apos;s page, or when someone phones our number.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }} className="stack">
          {calls.map((c) => {
            const st = STATUS[c.status] ?? { t: c.status, cls: "" };
            const lines = turns.get(c.id) ?? [];
            const sig = c.signals as { handoff?: string[]; email_links?: string; do_not_call?: boolean; do_not_contact?: boolean; guard_blocks?: number };
            return (
              <li key={c.id} id={`call-${c.id}`} className="card stack">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>
                    {c.clinic_id ? <Link href={`/portal/clinic/${c.clinic_id}`}>{c.clinic_name ?? "Clinic"}</Link> : "Caller not matched to a clinic"}
                  </strong>
                  <span>
                    <span className="pill">{c.direction === "inbound" ? "They called" : "We called"}</span>{" "}
                    <span className={`pill ${st.cls}`}>{st.t}</span>{" "}
                    {c.outcome ? <span className="pill">{OUTCOME[c.outcome] ?? c.outcome.replace(/_/g, " ")}</span> : null}
                    {c.dry_run && c.direction === "outbound" && c.status === "completed" ? <span className="pill pill-warn">Dry run</span> : null}
                  </span>
                </div>
                <div className="small muted">
                  {displayPhone(c.phone)}{c.contact_name ? ` · ${c.contact_name}` : ""} · {when(c.started_at ?? c.scheduled_for ?? c.created_at)}
                  {c.duration_seconds ? ` · ${Math.ceil(c.duration_seconds / 60)} min` : ""}
                  {c.attempts > 1 ? ` · attempt ${c.attempts}` : ""}
                </div>
                <div className="small">{consentLine(c)}</div>
                {c.summary ? <p style={{ margin: 0 }}>{c.summary}</p> : null}
                {c.last_error && c.status !== "completed" ? <p className="small muted" style={{ margin: 0 }}>{c.last_error}</p> : null}
                {(sig.handoff?.length || sig.email_links || sig.do_not_call || sig.do_not_contact) ? (
                  <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                    {(sig.handoff ?? []).map((h, i) => <li key={i}><strong>Needs you:</strong> {h}</li>)}
                    {sig.email_links === "queued" ? <li>Asked for the links by email: a draft is in the <Link href="/portal">queue</Link>.</li> : null}
                    {sig.email_links === "no_address" ? <li>Asked for the links by email, but no address is on file.</li> : null}
                    {sig.do_not_call ? <li>Asked not to be called: the number is on the do-not-call list.</li> : null}
                    {sig.do_not_contact ? <li>Asked for no contact at all: the number and the clinic&apos;s addresses are suppressed.</li> : null}
                  </ul>
                ) : null}
                {c.review_flags?.length ? (
                  <div className="banner banner-warn" role="note" style={{ borderRadius: 8 }}>
                    <strong>To check: the assistant said something its report does not support.</strong>
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                      {c.review_flags.map((f, i) => <li key={i}><q>{f.said}</q> {f.issue}</li>)}
                    </ul>
                  </div>
                ) : null}
                {lines.length ? (
                  <details>
                    <summary style={{ cursor: "pointer", fontWeight: 600, minHeight: 44, display: "flex", alignItems: "center" }}>Transcript ({lines.length} lines)</summary>
                    <ol style={{ listStyle: "none", padding: 0, margin: 0 }} className="stack">
                      {lines.map((t) => (
                        <li key={t.seq} className="small" style={{ wordBreak: "break-word" }}>
                          <strong>{t.role === "agent" ? "Assistant" : t.role === "caller" ? "Caller" : "Note"}:</strong> {t.text}
                          {t.blocked_text ? (
                            <div className="muted">
                              Stopped before it was spoken ({t.flags.map((f) => f.message).join("; ")}): <q>{t.blocked_text}</q>
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
                {c.status === "queued" ? (
                  <form action={cancelCallAction.bind(null, c.id)}>
                    <button className="btn">Cancel this call</button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <section className="card stack" aria-labelledby="dnc-h">
        <h2 id="dnc-h" style={{ fontSize: "1.1rem", margin: 0 }}>Do-not-call list ({dnc.length})</h2>
        <p className="small muted" style={{ margin: 0 }}>
          A number lands here when someone tells the assistant not to call, or when it reaches a wrong number. It is never dialled again.
        </p>
        {sp.dnc === "invalid" ? <p className="pill pill-bad" role="alert">That is not a Canadian phone number.</p> : null}
        <form action={addCallSuppressionAction} className="row" style={{ alignItems: "flex-end" }}>
          <div><label htmlFor="dnc-phone">Add a number</label><input id="dnc-phone" name="phone" type="tel" required maxLength={24} /></div>
          <div style={{ flex: "1 1 200px" }}><label htmlFor="dnc-reason">Why</label><input id="dnc-reason" name="reason" type="text" maxLength={200} /></div>
          <button className="btn">Add</button>
        </form>
        {dnc.length ? (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {dnc.map((d) => <li key={d.phone}>{displayPhone(d.phone)} · {d.reason} · {when(d.created_at)}</li>)}
          </ul>
        ) : null}
      </section>
    </section>
  );
}
