import { db } from "../db";
import { env, OWNER_PLACEHOLDER_RE } from "../env";
import { sha256, unsubscribeUrl } from "../tokens";
import { putFile } from "../storage";
import { embeddedFonts } from "./html";
import { renderTeaser } from "./renderTeaser";
import { OFFER_MARKER } from "./offerSection";
import { prepareTeaserRebuild, renderTeaserPdf, reportUrl } from "../pipeline/teaserJobs";
import type { TeaserData } from "./types";

/**
 * Brings what is already stored in line with src/lib/offer.ts, after the plans
 * changed (run it with scripts/offer-backfill.ts).
 *
 * 1. Every teaser report still in use: its page is rendered again from its
 *    stored data, so it holds the marker the plans are written into when it is
 *    shown, not the old cards. No model call; the data is not changed.
 * 2. Every teaser email that has not been sent: its text is built again by the
 *    builder the teaser job uses, with its hash, its claims and the PDF it
 *    attaches. Its status, its schedule, its flags and its review fields stay
 *    exactly as they are. A sent message is never touched.
 *
 * It only writes what it can keep true. An email is left as it is, and
 * counted, when the owner edited it, when the rebuilt text would change
 * anything but the option lines (unless `all`), when the rebuilt text would
 * fail the wording or sender check, or when this run's environment (address,
 * signing secret, sender details, PDF storage) is not the one the email was
 * written in. Running it twice changes nothing the second time.
 */

/** Statuses of a message that can still be sent. A draft is not here: the verification job rebuilds it. */
export const UNSENT = ["pending_review", "held", "approved", "scheduled"];
const TEASER_EMAILS = ["first_email", "self_serve_teaser"];
const ACTOR = "system: offer backfill";

export type LeftReason =
  | "other_lines" | "edited" | "links" | "placeholders" | "wording" | "storage" | "no_report" | "unreadable" | "pdf_failed" | "moved" | "limit";

export const LEFT_TEXT: Record<LeftReason, string> = {
  other_lines: "other lines would change too (run with --all to rebuild these)",
  edited: "edited by the owner (never rebuilt)",
  links: "the report or unsubscribe link of this environment is not the one in the email (APP_URL or APP_SECRET differ)",
  placeholders: "the sender details of this environment are placeholders",
  wording: "the rebuilt text fails the wording or sender check",
  storage: "this environment stores PDFs somewhere else than the report's PDF is",
  no_report: "no report that passed the gate",
  unreadable: "the report's stored data could not be built from again",
  pdf_failed: "the PDF could not be rendered",
  moved: "sent or changed while this ran",
  limit: "not reached in this run (--limit)",
};

export interface BackfillOptions {
  /** Count only: nothing is written. */
  dry: boolean;
  /** Also rebuild emails whose text would change outside the option lines. Never one the owner edited. */
  all?: boolean;
  /** Rebuild at most this many emails in this run. */
  limit?: number;
  pdf?: (html: string) => Promise<Buffer>;
  put?: (key: string, data: Buffer, contentType: string) => Promise<string>;
  /** Called after each email, for a progress line. */
  progress?: (done: number, total: number) => void;
}

export interface BackfillResult {
  dry: boolean;
  teasers: { total: number; rendered: number; current: number; failed: string[] };
  emails: {
    total: number;
    byStatus: Record<string, number>;
    /** Rebuilt (in a dry run: would be rebuilt). */
    rebuilt: string[];
    /** Of those, the ones where more than the option lines change (only with `all`). */
    rebuiltOtherLines: number;
    current: number;
    left: Partial<Record<LeftReason, string[]>>;
    /** For the first few emails left for "other_lines": the first line that differs, old and new. */
    samples: { id: string; was: string; now: string }[];
  };
  /** Drafts waiting for the verification job, which builds them with the current wording. */
  drafts: number;
  /** Unsent messages of other types that name a retired plan or price. Not changed here. */
  otherMentions: Record<string, number>;
}

export const BACKFILL_USAGE = "usage: npx tsx --env-file=<env file> scripts/offer-backfill.ts [--dry] [--all] [--limit <n>]";

/**
 * The script's arguments. Anything it does not know is an error, never
 * ignored: a mistyped "--dry" must not turn into a run that writes.
 */
export function parseBackfillArgs(argv: string[]): { dry: boolean; all: boolean; limit?: number } {
  const out: { dry: boolean; all: boolean; limit?: number } = { dry: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry" || a === "--dry-run") out.dry = true;
    else if (a === "--all") out.all = true;
    else if (a === "--limit") {
      const value = argv[++i];
      const n = Number(value);
      if (value === undefined || !/^\d+$/.test(value) || !Number.isInteger(n)) throw new Error(BACKFILL_USAGE);
      out.limit = n;
    } else throw new Error(`unknown argument "${a}"\n${BACKFILL_USAGE}`);
  }
  return out;
}

/** The body without its option lines: what must stay the same for a rebuild to be "only the offer". */
const withoutOptions = (body: string) => body.split("\n").filter((l) => !l.startsWith("- ")).join("\n");

function firstDifference(was: string, now: string): { was: string; now: string } {
  const a = withoutOptions(was).split("\n");
  const b = withoutOptions(now).split("\n");
  const i = a.findIndex((l, n) => l !== b[n]);
  const at = i === -1 ? Math.min(a.length, b.length) : i;
  return { was: (a[at] ?? "(nothing)").slice(0, 160), now: (b[at] ?? "(nothing)").slice(0, 160) };
}

const storageKind = (): string => (env().NEXT_PUBLIC_SUPABASE_URL && env().SUPABASE_SERVICE_ROLE_KEY ? "supabase" : "local");
const kindOf = (ref: string): string => ref.slice(0, ref.indexOf(":"));

/** The owner's own edit is the last word on a message: it is not written over. */
async function editedByOwner(messageId: string): Promise<boolean> {
  const [last] = await db()<{ actor_email: string | null }[]>`
    select actor_email from approval_log where message_id=${messageId} and action='edit' order by at desc, id desc limit 1`;
  return !!last && !(last.actor_email ?? "").startsWith("system:");
}

async function backfillTeaserPages(dry: boolean): Promise<BackfillResult["teasers"]> {
  const sql = db();
  const out: BackfillResult["teasers"] = { total: 0, rendered: 0, current: 0, failed: [] };
  const ids = await sql<{ id: string }[]>`select id from reports where kind='teaser' and not superseded order by created_at`;
  out.total = ids.length;
  for (const { id } of ids) {
    const [r] = await sql<{ data: TeaserData; html: string }[]>`select data, html from reports where id=${id}`;
    if (!r) continue;
    let html: string;
    try {
      html = renderTeaser(r.data);
      if (!html.includes(OFFER_MARKER)) throw new Error("no marker");
    } catch {
      // stored data from an older shape: the page stays as it is (the old cards are still swapped when it is shown)
      out.failed.push(id);
      continue;
    }
    if (html === r.html) {
      out.current++;
      continue;
    }
    if (!dry) await sql`update reports set html=${html} where id=${id}`;
    out.rendered++;
  }
  return out;
}

async function backfillTeaserEmails(o: BackfillOptions): Promise<BackfillResult["emails"]> {
  const sql = db();
  const out: BackfillResult["emails"] = { total: 0, byStatus: {}, rebuilt: [], rebuiltOtherLines: 0, current: 0, left: {}, samples: [] };
  const leave = (why: LeftReason, id: string) => { (out.left[why] ??= []).push(id); };
  const rows = await sql<{ id: string; status: string }[]>`
    select id, status::text from messages where type in ${sql(TEASER_EMAILS)} and status in ${sql(UNSENT)} order by created_at`;
  out.total = rows.length;
  for (const r of rows) out.byStatus[r.status] = (out.byStatus[r.status] ?? 0) + 1;

  let done = 0;
  for (const row of rows) {
    o.progress?.(++done, rows.length);
    let r: Awaited<ReturnType<typeof prepareTeaserRebuild>>;
    try {
      r = await prepareTeaserRebuild(row.id, UNSENT);
    } catch {
      // stored data from an older shape: one email that cannot be rebuilt does not stop the rest
      leave("unreadable", row.id);
      continue;
    }
    if ("skipped" in r) {
      leave(r.skipped.startsWith("message is") ? "moved" : "no_report", row.id);
      continue;
    }
    const { msg, rep, draft } = r;
    if (msg.subject === draft.subject && msg.body_text === draft.bodyText) {
      out.current++;
      continue;
    }
    if (await editedByOwner(msg.id)) { leave("edited", msg.id); continue; }
    // the stored email must carry the links this environment would write: otherwise this is not the environment it was written in
    if (!msg.body_text.includes(reportUrl(rep.token)) || !msg.body_text.includes(unsubscribeUrl(msg.to_email))) { leave("links", msg.id); continue; }
    if (OWNER_PLACEHOLDER_RE.test(draft.bodyText) && !OWNER_PLACEHOLDER_RE.test(msg.body_text)) { leave("placeholders", msg.id); continue; }
    if (r.blocked) { leave("wording", msg.id); continue; }
    const onlyOptions = msg.subject === draft.subject && withoutOptions(msg.body_text) === withoutOptions(draft.bodyText);
    if (!onlyOptions && !o.all) {
      leave("other_lines", msg.id);
      if (out.samples.length < 3) out.samples.push({ id: msg.id, ...(msg.subject === draft.subject ? firstDifference(msg.body_text, draft.bodyText) : { was: msg.subject.slice(0, 160), now: draft.subject.slice(0, 160) }) });
      continue;
    }
    if (!o.put && rep.pdf_path && kindOf(rep.pdf_path) !== storageKind()) { leave("storage", msg.id); continue; }
    if (o.limit != null && out.rebuilt.length >= o.limit) { leave("limit", msg.id); continue; }

    if (!o.dry) {
      let pdf: Buffer;
      try {
        pdf = await renderTeaserPdf(r, o.pdf);
      } catch {
        // the email and the PDF it attaches change together or not at all
        leave("pdf_failed", msg.id);
        continue;
      }
      const written = await sql.begin(async (tx) => {
        // the row is locked until this is stored, so the send job cannot take the message half-way
        const [cur] = await tx<{ status: string; subject: string; body_text: string }[]>`
          select status::text, subject, body_text from messages where id=${msg.id} for update`;
        if (!cur || cur.status !== msg.status || cur.subject !== msg.subject || cur.body_text !== msg.body_text) return false;
        const pdfRef = await (o.put ?? putFile)(`reports/${rep.token}.pdf`, pdf, "application/pdf");
        await tx`update reports set data=${tx.json({ ...rep.data, owner: r.data.owner } as never)}, html=${r.html},
                  pdf_path=${pdfRef}, pdf_bytes=${pdf.length} where id=${msg.report_id}`;
        // the text, and what is stored with it: nothing that decides whether or when it is sent
        await tx`update messages set subject=${draft.subject}, body_text=${draft.bodyText}, body_html=null,
                  claims=${tx.json([...r.data.claims, ...draft.claims] as never)},
                  content_hash=${sha256(draft.subject + "\n" + draft.bodyText)}
                  where id=${msg.id}`;
        await tx`insert into approval_log (message_id, action, actor_email, before, after)
                 values (${msg.id}, 'edit', ${ACTOR},
                         ${tx.json({ subject: msg.subject, body_text: msg.body_text } as never)},
                         ${tx.json({ subject: draft.subject, body_text: draft.bodyText } as never)})`;
        return true;
      });
      if (!written) { leave("moved", msg.id); continue; }
    }
    out.rebuilt.push(msg.id);
    if (!onlyOptions) out.rebuiltOtherLines++;
  }
  return out;
}

export async function runOfferBackfill(o: BackfillOptions): Promise<BackfillResult> {
  // A report page carries its fonts. Rendered where they cannot be read, every page would lose them.
  if ((embeddedFonts().match(/@font-face/g) ?? []).length < 6) {
    throw new Error("the report fonts were not found: run from the repository root, with node_modules installed");
  }
  const sql = db();
  const teasers = await backfillTeaserPages(o.dry);
  const emails = await backfillTeaserEmails(o);
  const [d] = await sql<{ n: number }[]>`select count(*)::int as n from messages where type in ${sql(TEASER_EMAILS)} and status='draft'`;
  const other = await sql<{ type: string; n: number }[]>`
    select type::text, count(*)::int as n from messages
    where status in ${sql(["draft", ...UNSENT])} and type not in ${sql([...TEASER_EMAILS, "owner_digest", "owner_alert"])}
      and (body_text ~ '\\m150 CAD' or body_text ~* 'monthly reports' or body_text ~* 'full service plan')
    group by 1 order by 1`;
  return { dry: o.dry, teasers, emails, drafts: d.n, otherMentions: Object.fromEntries(other.map((x) => [x.type, x.n])) };
}

/** The result as the lines the script prints. */
export function backfillReport(r: BackfillResult): string[] {
  const e = r.emails;
  const statuses = Object.entries(e.byStatus).map(([k, n]) => `${k} ${n}`).join(", ");
  const lines = [
    `Teaser reports in use: ${r.teasers.total}`,
    `  ${r.dry ? "to render again" : "rendered again"}, with the plan marker: ${r.teasers.rendered}`,
    `  already current: ${r.teasers.current}`,
    `  stored data could not be rendered (left as they are): ${r.teasers.failed.length}${r.teasers.failed.length ? `  ${r.teasers.failed.slice(0, 20).join(" ")}` : ""}`,
    ``,
    `Unsent teaser emails: ${e.total}${statuses ? ` (${statuses})` : ""}`,
    `  ${r.dry ? "to rebuild" : "rebuilt"}, text and PDF: ${e.rebuilt.length}${e.rebuiltOtherLines ? ` (${e.rebuiltOtherLines} of them change outside the option lines)` : ""}`,
    `  already current: ${e.current}`,
  ];
  const left = Object.entries(e.left) as [LeftReason, string[]][];
  if (left.length) lines.push(`  left as they are:`);
  for (const [why, ids] of left) lines.push(`    ${LEFT_TEXT[why]}: ${ids.length}  ${ids.slice(0, 20).join(" ")}${ids.length > 20 ? " ..." : ""}`);
  for (const s of e.samples) lines.push(`    example ${s.id}`, `      was: ${s.was}`, `      now: ${s.now}`);
  lines.push(``, `Teaser drafts waiting for verification (it builds them with the current wording): ${r.drafts}`);
  const other = Object.entries(r.otherMentions);
  lines.push(`Other unsent messages that name a retired plan or price (not changed; reword them in the portal): ${other.reduce((n, [, x]) => n + x, 0)}${other.length ? ` (${other.map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}`);
  return lines;
}
