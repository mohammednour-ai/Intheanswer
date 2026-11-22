import { db } from "./db";
import { chargesHst } from "./env";
import { REPORT_CREDIT, isTierKey, priceAnswer, priceText, termText } from "./offer";

/**
 * The owner's approved answers to the questions and objections clinics raise
 * (table `approved_answers`, edited in Portal > Answers). They are used in two
 * places: drafts of email replies, and the phone agent's brief.
 *
 * An answer never types a price. Where it needs one it holds a placeholder,
 * filled in from src/lib/offer.ts each time the answer is read, so an answer
 * can never repeat an old price:
 *
 *   {{price_answer}}        the whole "how much does it cost?" answer
 *   {{price:visibility}}    "200 CAD a month" (report, visibility, growth, transformation)
 *   {{term:growth}}         "6-month minimum, then month to month"
 *   {{credit_days}}         30
 */
export const ANSWER_PLACEHOLDERS = ["{{price_answer}}", "{{price:report}}", "{{price:visibility}}", "{{price:growth}}", "{{price:transformation}}", "{{term:visibility}}", "{{term:growth}}", "{{credit_days}}"];

export function expandAnswer(text: string): string {
  return text
    .replace(/\{\{price_answer\}\}/g, () => priceAnswer(chargesHst()))
    .replace(/\{\{price:(\w+)\}\}/g, (whole, k: string) => (isTierKey(k) ? priceText(k) : whole))
    .replace(/\{\{term:(\w+)\}\}/g, (whole, k: string) => (isTierKey(k) ? termText(k) : whole))
    .replace(/\{\{credit_days\}\}/g, String(REPORT_CREDIT.days));
}

/** A placeholder that expandAnswer does not know is a typing slip: the answer would be sent with braces in it. */
export function unknownPlaceholders(text: string): string[] {
  return expandAnswer(text).match(/\{\{[^}]*\}\}/g) ?? [];
}

export interface ApprovedAnswer {
  id: number;
  key: string;
  question: string;
  /** As stored, with placeholders. */
  answer: string;
  /** "any": email replies and the phone. "phone": worded for a call, never drafted into an email. */
  channel: "any" | "phone";
  active: boolean;
}

export async function listAnswers(): Promise<ApprovedAnswer[]> {
  return db()<ApprovedAnswer[]>`select id, key, question, answer, channel, active from approved_answers order by channel, id`;
}

/** The active answers for one use, with every placeholder filled in. */
export async function answersFor(use: "email" | "phone"): Promise<{ key: string; question: string; answer: string }[]> {
  const sql = db();
  const rows = await sql<{ key: string; question: string; answer: string }[]>`
    select key, question, answer from approved_answers
    where active and ${use === "email" ? sql`channel = 'any'` : sql`true`} order by id`;
  return rows.map((r) => ({ ...r, answer: expandAnswer(r.answer) }));
}
