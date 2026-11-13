import { z } from "zod";
import { db } from "../db";
import type { JobContext } from "../jobs/queue";
import { PermanentJobError } from "../jobs/queue";
import { register } from "../jobs/handlers";
import {
  askPatientQuestion, structured, ASSISTANT_NAME, ClaudeIncompleteError, ClaudeRefusalError,
  type CallSpend, type PatientAnswer,
} from "../adapters/claude";
import { env } from "../env";
import { textContains } from "../site/parse";
import type { NamedClinic } from "./match";

/**
 * Step 3: run the sector's question set for a city through the assistant with
 * web search on. One run per (sector, city, question set, month) is shared by
 * every clinic in that city. Resumable: answered questions are not re-asked.
 *
 * One bad question does not end the run. A question the assistant refuses, or
 * that still fails on the job's last attempt, is recorded in
 * test_runs.skipped_questions and is NOT a test_answers row, so every score
 * counts answered questions only. A truncated or empty response is never
 * stored as an answer. With fewer than MIN_ANSWERED answers the run fails
 * for good.
 */

/** A run with fewer answered questions than this says too little to report on. */
export const MIN_ANSWERED = 4;
/** Tries per question inside one job attempt, for a cut-off or empty answer. */
const TRIES_PER_QUESTION = 2;

export interface SkippedQuestion {
  index: number;
  question: string;
  reason: string;
}

const NamedSchema = z.object({
  clinics: z.array(
    z.object({
      name: z.string().describe("The business name exactly as written in the answer"),
      url: z.string().nullable().describe("The clinic's own website if the answer gives or links it, else null"),
      status: z.enum(["recommended", "listed_only"]),
      quote: z.string().describe("A short exact quote from the answer where this business appears"),
    }),
  ),
});

const EXTRACT_SYSTEM = `You extract which local businesses an AI assistant's answer named. You are precise and literal.
Rules:
- Include every specific business (clinic, practice, spa) named in the answer text. Do not include directories, booking platforms, review sites, government bodies or associations.
- status "recommended": the answer puts the business forward as an option for the person's request (a suggestion, a pick, an item in a list of places to try).
- status "listed_only": the business is named but not put forward (mentioned in passing, as a caveat, as an example of something to avoid, or only as a source).
- quote must be copied exactly from the answer text, 5 to 25 words, and contain the business name.
- Never add a business that is not in the answer.`;

export async function extractNamed(question: string, answerText: string) {
  const r = await structured({
    purpose: "named",
    system: EXTRACT_SYSTEM,
    user: `Question the person asked:\n${question}\n\nAssistant's answer:\n<answer>\n${answerText}\n</answer>`,
    schema: NamedSchema,
    effort: "medium",
  });
  // keep only entries whose quote really is in the answer
  const verified: NamedClinic[] = r.data.clinics.filter((c) => textContains(answerText, c.quote) || textContains(answerText, c.name));
  return { named: verified, dropped: r.data.clinics.length - verified.length, costUsd: r.costUsd, usage: r.usage };
}

type Outcome =
  | { ok: true; answer: PatientAnswer; named: NamedClinic[]; dropped: number }
  /** final: asking again will not help (refused), so skip now instead of retrying the job */
  | { ok: false; final: boolean; reason: string };

const spendOf = (e: unknown): CallSpend | null =>
  e instanceof ClaudeRefusalError || e instanceof ClaudeIncompleteError ? e.spend : null;
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * Ask one question and extract the clinics named. Every call that was billed
 * is recorded as it happens, so a later failure never loses the cost.
 */
async function answerQuestion(ctx: JobContext, question: string, city: string): Promise<Outcome> {
  let answer: PatientAnswer | null = null;
  let lastReason = "";
  for (let attempt = 1; attempt <= TRIES_PER_QUESTION && !answer; attempt++) {
    try {
      answer = await askPatientQuestion(question, city);
      await ctx.cost({ provider: "anthropic", operation: "test_question", units: { ...answer.usage, model: answer.servedModel }, costUsd: answer.costUsd });
    } catch (e) {
      const spend = spendOf(e);
      if (spend) {
        await ctx.cost({ provider: "anthropic", operation: "test_question", units: { ...spend.usage, model: spend.servedModel, failed: true }, costUsd: spend.costUsd });
      }
      if (e instanceof ClaudeRefusalError) return { ok: false, final: true, reason: `the assistant declined to answer (${short(e)})` };
      lastReason = short(e);
      // only a cut-off or empty answer is worth asking again right away; the SDK already retried network and API errors
      if (!(e instanceof ClaudeIncompleteError)) break;
    }
  }
  if (!answer) return { ok: false, final: false, reason: lastReason || "no answer" };

  for (let attempt = 1; attempt <= TRIES_PER_QUESTION; attempt++) {
    try {
      const ex = await extractNamed(question, answer.text);
      await ctx.cost({ provider: "anthropic", operation: "extract_named", units: ex.usage as never, costUsd: ex.costUsd });
      return { ok: true, answer, named: ex.named, dropped: ex.dropped };
    } catch (e) {
      const spend = spendOf(e);
      if (spend) {
        await ctx.cost({ provider: "anthropic", operation: "extract_named", units: { ...spend.usage, model: spend.servedModel, failed: true }, costUsd: spend.costUsd });
      }
      if (e instanceof ClaudeRefusalError) return { ok: false, final: true, reason: `reading the answer was declined (${short(e)})` };
      lastReason = `the answer could not be read: ${short(e)}`;
      if (!(e instanceof ClaudeIncompleteError)) break;
    }
  }
  return { ok: false, final: false, reason: lastReason };
}

async function handleTestCity(ctx: JobContext) {
  const { sectorId, cityId, runLabel } = ctx.job.payload as { sectorId: number; cityId: number; runLabel: string };
  const sql = db();
  const [qs] = await sql<{ id: number; questions: string[] }[]>`
    select id, questions from question_sets where sector_id=${sectorId} and active order by version desc limit 1`;
  const [city] = await sql<{ name: string }[]>`select name from cities where id=${cityId}`;
  if (!qs || !city) throw new PermanentJobError("no active question set or unknown city");

  const [run] = await sql<{ id: string; finished_at: Date | null; skipped_questions: SkippedQuestion[] | null }[]>`
    insert into test_runs (sector_id, city_id, question_set_id, assistant, model, run_label)
    values (${sectorId}, ${cityId}, ${qs.id}, ${ASSISTANT_NAME}, ${env().CLAUDE_MODEL}, ${runLabel})
    on conflict (sector_id, city_id, question_set_id, run_label) do update set run_label = excluded.run_label
    returning id, finished_at, skipped_questions`;
  if (run.finished_at) return { testRunId: run.id, already: true };

  const done = new Set(
    (await sql<{ question_index: number }[]>`select question_index from test_answers where test_run_id=${run.id}`).map((r) => r.question_index),
  );
  const skipped: SkippedQuestion[] = (run.skipped_questions ?? []).filter((s) => !done.has(s.index));
  const lastAttempt = ctx.job.attempts >= ctx.job.max_attempts;
  const retryLater: string[] = [];

  for (let i = 0; i < qs.questions.length; i++) {
    if (done.has(i) || skipped.some((s) => s.index === i)) continue;
    const question = qs.questions[i].replaceAll("{city}", city.name);
    const r = await answerQuestion(ctx, question, city.name);
    if (!r.ok) {
      if (r.final || lastAttempt) {
        skipped.push({ index: i, question, reason: r.reason });
        await sql`update test_runs set skipped_questions=${sql.json(skipped as never)} where id=${run.id}`;
        await ctx.log("question skipped", { i, reason: r.reason }, "warn");
      } else {
        retryLater.push(`question ${i + 1}: ${r.reason}`);
        await ctx.log("question failed, will be tried again", { i, reason: r.reason }, "warn");
      }
      continue; // the other questions still run
    }
    const a = r.answer;
    if (r.dropped) await ctx.log("dropped named entries without an exact quote", { question: i, dropped: r.dropped }, "warn");
    await sql`
      insert into test_answers (test_run_id, question_index, question, answer_text, sources, clinics_named, raw,
                                asked_at, served_model, stop_reason, usage)
      values (${run.id}, ${i}, ${question}, ${a.text}, ${sql.json(a.sources as never)}, ${sql.json(r.named as never)},
              ${sql.json({ citations: a.citations } as never)}, ${a.askedAt}, ${a.servedModel}, ${a.stopReason},
              ${sql.json(a.usage as never)})
      on conflict (test_run_id, question_index) do nothing`;
    done.add(i);
    await ctx.log("question answered", { i, named: r.named.map((n) => `${n.name} (${n.status})`), sources: a.sources.length });
  }

  // Questions that failed for a reason that may pass (network, a cut-off
  // answer) are tried again on the job's next attempt; answered and skipped
  // ones are kept and not asked twice.
  if (retryLater.length) throw new Error(`${retryLater.length} question(s) failed: ${retryLater.join("; ")}`.slice(0, 900));

  const need = Math.min(MIN_ANSWERED, qs.questions.length);
  if (done.size < need) {
    const error = `only ${done.size} of ${qs.questions.length} questions were answered (need ${need}); skipped: ${skipped.map((s) => `${s.index + 1} (${s.reason})`).join("; ")}`.slice(0, 900);
    await sql`update test_runs set error=${error} where id=${run.id}`;
    throw new PermanentJobError(error);
  }
  await sql`update test_runs set finished_at = now(), error = null where id = ${run.id}`;
  return { testRunId: run.id, answered: done.size, skipped: skipped.map((s) => s.index) };
}

export { handleTestCity };

register("test_city", handleTestCity);
