import { z } from "zod";
import { db } from "../db";
import type { JobContext } from "../jobs/queue";
import { PermanentJobError } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { askPatientQuestion, structured, ASSISTANT_NAME } from "../adapters/claude";
import { env } from "../env";
import { textContains } from "../site/parse";
import type { NamedClinic } from "./match";

/**
 * Step 3: run the sector's question set for a city through the assistant with
 * web search on. One run per (sector, city, question set, month) is shared by
 * every clinic in that city. Resumable: answered questions are not re-asked.
 */

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

async function handleTestCity(ctx: JobContext) {
  const { sectorId, cityId, runLabel } = ctx.job.payload as { sectorId: number; cityId: number; runLabel: string };
  const sql = db();
  const [qs] = await sql<{ id: number; questions: string[] }[]>`
    select id, questions from question_sets where sector_id=${sectorId} and active order by version desc limit 1`;
  const [city] = await sql<{ name: string }[]>`select name from cities where id=${cityId}`;
  if (!qs || !city) throw new PermanentJobError("no active question set or unknown city");

  const [run] = await sql<{ id: string; finished_at: Date | null }[]>`
    insert into test_runs (sector_id, city_id, question_set_id, assistant, model, run_label)
    values (${sectorId}, ${cityId}, ${qs.id}, ${ASSISTANT_NAME}, ${env().CLAUDE_MODEL}, ${runLabel})
    on conflict (sector_id, city_id, question_set_id, run_label) do update set run_label = excluded.run_label
    returning id, finished_at`;
  if (run.finished_at) return { testRunId: run.id, already: true };

  const done = new Set(
    (await sql<{ question_index: number }[]>`select question_index from test_answers where test_run_id=${run.id}`).map((r) => r.question_index),
  );
  for (let i = 0; i < qs.questions.length; i++) {
    if (done.has(i)) continue;
    const question = qs.questions[i].replaceAll("{city}", city.name);
    const a = await askPatientQuestion(question, city.name);
    await ctx.cost({ provider: "anthropic", operation: "test_question", units: { ...a.usage, model: a.servedModel }, costUsd: a.costUsd });
    const ex = await extractNamed(question, a.text);
    await ctx.cost({ provider: "anthropic", operation: "extract_named", units: ex.usage as never, costUsd: ex.costUsd });
    if (ex.dropped) await ctx.log("dropped named entries without an exact quote", { question: i, dropped: ex.dropped }, "warn");
    await sql`
      insert into test_answers (test_run_id, question_index, question, answer_text, sources, clinics_named, raw,
                                asked_at, served_model, stop_reason, usage)
      values (${run.id}, ${i}, ${question}, ${a.text}, ${sql.json(a.sources as never)}, ${sql.json(ex.named as never)},
              ${sql.json({ citations: a.citations } as never)}, ${a.askedAt}, ${a.servedModel}, ${a.stopReason},
              ${sql.json(a.usage as never)})
      on conflict (test_run_id, question_index) do nothing`;
    await ctx.log("question answered", { i, named: ex.named.map((n) => `${n.name} (${n.status})`), sources: a.sources.length });
  }
  await sql`update test_runs set finished_at = now() where id = ${run.id}`;
  return { testRunId: run.id };
}

register("test_city", handleTestCity);
