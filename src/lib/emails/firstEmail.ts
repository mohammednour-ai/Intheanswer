import type { Claim, TeaserData } from "../reports/types";
import { unsubscribeUrl } from "../tokens";

/**
 * The first email: plain, short and personal. Subject states the clinic's
 * result. Body: what was asked, what came back, two findings, the link, the
 * two offers one line each, sender identity and a one-click unsubscribe.
 */

export interface Draft {
  subject: string;
  bodyText: string;
  claims: Claim[];
}

export function firstEmailSubject(d: TeaserData): string {
  const { recommended: r, total: t } = d.score;
  return r === 0
    ? `${d.clinic.name} was not recommended in any of ${t} AI answers for ${d.clinic.city} patients`
    : `${d.clinic.name} was recommended in ${r} of ${t} AI answers for ${d.clinic.city} patients`;
}

/** Most often recommended other clinics across the answers (facts from the answers, neutral). */
export function topNamedInstead(d: TeaserData, n = 3): string[] {
  const count = new Map<string, number>();
  for (const r of d.rows) for (const x of r.namedInstead) count.set(x, (count.get(x) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

export function buildFirstEmail(d: TeaserData, opts: { toEmail: string; sourceUrl: string; reportUrl: string }): Draft {
  const claims: Claim[] = [];
  const example = d.rows.find((r) => r.status !== "recommended") ?? d.rows[0];
  const others = topNamedInstead(d);
  const { recommended: r, total: t } = d.score;

  const whatCameBack =
    r === 0
      ? `It did not recommend ${d.clinic.name} in any of them.`
      : `It recommended ${d.clinic.name} in ${r} of them.`;
  const namedLine = others.length ? ` The clinics it named most often were ${others.join(", ")}.` : "";
  claims.push({
    id: "email-result",
    where: "email",
    claim: `${whatCameBack}${namedLine}`.trim(),
    evidence: d.rows.map((row) => ({ kind: "answer_quote" as const, ref: row.answerId, label: `${row.status}; named: ${row.namedInstead.join(", ")}` })),
  });

  const two = d.findings.slice(0, 2);
  two.forEach((f, i) => claims.push({ id: `email-finding-${i}`, where: "email", claim: f.text, evidence: f.evidence }));

  const body = [
    `Hello ${d.clinic.name} team,`,
    ``,
    `On ${d.test.date} I asked ${d.test.assistant}, an AI assistant, ${t} questions a patient in ${d.clinic.city} might ask, such as "${example.question}" ${whatCameBack}${namedLine}`,
    ``,
    `Two things I noticed on ${d.clinic.domain}:`,
    ...two.map((f, i) => `${i + 1}. ${f.text}`),
    ``,
    `The free report has every question, who was named, and a third finding:`,
    opts.reportUrl,
    `(A PDF copy is attached.)`,
    ``,
    `If you want it fixed:`,
    `- Full report and fix files: 200 CAD, one time.`,
    `- Monthly plan: 200 CAD a month. I rebuild or upgrade your site, install every fix and retest each month.`,
    ``,
    `Either way, the report is yours to keep.`,
    ``,
    `${d.owner.name}`,
    `${d.owner.businessName}`,
    `${d.owner.mailingAddress} · ${d.owner.phone}`,
    `intheanswer.ca`,
    ``,
    `--`,
    `You are receiving this because ${opts.toEmail} is published on ${opts.sourceUrl}. To stop all emails from me, use this link (no login needed): ${unsubscribeUrl(opts.toEmail)}`,
  ].join("\n");

  return { subject: firstEmailSubject(d), bodyText: body, claims };
}
