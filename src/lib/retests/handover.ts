import type { enqueue as Enqueue } from "../jobs/queue";

/**
 * How a retest travels through the scoring step: the retest job puts this on
 * the `score_clinic` payload, and the scoring step hands the finished score to
 * the matching report job instead of building a teaser.
 */
export type RetestContext =
  | { kind: "monthly"; cycle: string; subscriptionId: string | null; grace: boolean }
  | { kind: "purchase"; orderId: string };

export async function handOverRetestScore(
  enqueue: typeof Enqueue,
  s: { clinicId: string; scoreId: string; testRunId: string; runLabel: string | null; retest: RetestContext },
): Promise<string> {
  if (s.retest.kind === "monthly") {
    await enqueue("monthly_report", `monthly_report:${s.clinicId}:${s.retest.cycle}`, {
      clinicId: s.clinicId, scoreId: s.scoreId, cycle: s.retest.cycle, runLabel: s.runLabel ?? s.retest.cycle,
      subscriptionId: s.retest.subscriptionId, grace: s.retest.grace,
    }, { priority: 60 });
    return "monthly_report";
  }
  await enqueue("retest_upgrade", `retest_upgrade:${s.retest.orderId}`, {
    clinicId: s.clinicId, scoreId: s.scoreId, orderId: s.retest.orderId, runLabel: s.runLabel,
  }, { priority: 60 });
  return "retest_upgrade";
}
