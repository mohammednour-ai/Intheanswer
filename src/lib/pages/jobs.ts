import { db } from "../db";
import type { JobContext } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { parsePage } from "../site/parse";
import { getSettings } from "../settings";
import { proposePages, saveProposals } from "./propose";
import { generateDraft } from "./workflow";
import type { ClinicFacts } from "./draft";
import { competitorServiceWords } from "../reviews/serviceWords";
import type { NamedClinic } from "../pipeline/match";
import type { Evidence } from "../pipeline/audit/types";

/** Facts confirmed on the clinic's own site (never Places content). */
export async function clinicFacts(clinicId: string): Promise<ClinicFacts> {
  const sql = db();
  const [c] = await sql<{ name: string; site_name: string | null; website: string; address: string | null; phone: string | null;
    address_confirmed_on_site: boolean; phone_confirmed_on_site: boolean; city: string; sector: string; reg: string }[]>`
    select c.name, c.site_name, c.website, c.address, c.phone, c.address_confirmed_on_site, c.phone_confirmed_on_site,
           ci.name as city, se.slug as sector, se.regulator_note as reg
    from clinics c join cities ci on ci.id=c.city_id join sectors se on se.id=c.sector_id where c.id=${clinicId}`;
  const [hours] = await sql<{ evidence: Evidence[] }[]>`
    select ac.evidence from audit_checks ac join audits a on a.id=ac.audit_id
    where a.clinic_id=${clinicId} and not a.superseded and ac.check_key='hours' and ac.result='found' limit 1`;
  const hq = hours?.evidence?.find((e) => e.kind === "page_quote" && e.quote && e.url);
  return {
    name: c.site_name ?? c.name,
    city: c.city,
    sector: c.sector,
    website: c.website,
    address: c.address_confirmed_on_site ? c.address : null,
    phone: c.phone_confirmed_on_site ? c.phone : null,
    hoursQuote: hq ? { text: hq.quote!, url: hq.url! } : null,
    regulatorNote: c.reg,
  };
}

export async function sitePagesFromCache(domain: string) {
  const rows = await db()<{ url: string; body: string }[]>`
    select url, body from page_cache where domain=${domain} and http_status=200 and body is not null limit 60`;
  return rows.map((r) => {
    const p = parsePage(r.url, r.body);
    return { url: p.url, title: p.title, h1: p.h1, text: p.text };
  });
}

export async function proposeForClinic(clinicId: string, testRunId: string | null, opts: { draftFirst?: boolean } = {}) {
  const sql = db();
  const facts = await clinicFacts(clinicId);
  const [c] = await sql<{ domain: string; sector_id: number }[]>`select domain, sector_id from clinics where id=${clinicId}`;
  let questions: { index: number; text: string; status: "recommended" | "listed_only" | "not_named" | null }[] = [];
  let compWords: { word: string; count: number }[] = [];
  if (testRunId) {
    const rows = await sql<{ question_index: number; question: string; answer_text: string; clinics_named: NamedClinic[]; status: string | null }[]>`
      select a.question_index, a.question, a.answer_text, a.clinics_named, r.status::text
      from test_answers a left join clinic_test_results r on r.test_answer_id=a.id and r.clinic_id=${clinicId}
      where a.test_run_id=${testRunId} order by a.question_index`;
    questions = rows.map((r) => ({ index: r.question_index, text: r.question, status: (r.status as never) ?? null }));
    const cw = competitorServiceWords(facts.sector, facts.city, rows.map((r) => ({ questionIndex: r.question_index, text: r.answer_text, named: r.clinics_named })), [facts.name]);
    const agg = new Map<string, number>();
    cw.forEach((x) => x.words.forEach((w) => agg.set(w.word, (agg.get(w.word) ?? 0) + w.count)));
    compWords = [...agg.entries()].map(([word, count]) => ({ word, count }));
  } else {
    // no test yet: use the active question set for the city, without results
    const [qs] = await sql<{ questions: string[] }[]>`select questions from question_sets where sector_id=${c.sector_id} and active order by version desc limit 1`;
    questions = (qs?.questions ?? []).map((q, i) => ({ index: i, text: q.replaceAll("{city}", facts.city), status: null }));
  }
  const pages = await sitePagesFromCache(c.domain);
  const proposals = proposePages({ clinic: facts.name, city: facts.city, sector: facts.sector, questions, site: { pages }, competitorWords: compWords });
  const s = await getSettings();
  const ids = await saveProposals(clinicId, proposals, s.pages_per_month);
  let firstDraft = null;
  if (opts.draftFirst !== false && ids[0]) {
    const [st] = await sql<{ status: string }[]>`select status::text from answer_pages where id=${ids[0]}`;
    if (st.status === "proposed") firstDraft = await generateDraft(ids[0], facts, "system");
  }
  return { proposals, ids, firstDraft };
}

async function handleProposePages(ctx: JobContext) {
  const { clinicId, testRunId } = ctx.job.payload as { clinicId: string; testRunId: string | null };
  const r = await proposeForClinic(clinicId, testRunId ?? null);
  return { proposed: r.proposals.length, drafted: r.firstDraft ? 1 : 0 };
}

register("propose_pages", handleProposePages);
