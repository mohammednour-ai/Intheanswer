import { scanLanguage } from "../pipeline/verify";
import { OWNER_PLACEHOLDER_RE } from "../env";
import { forSpeech } from "./twiml";
import type { CallBrief } from "./brief";

/**
 * The check between the model and the caller's ear. Every line the agent is
 * about to speak passes through here first; a line that fails is not spoken,
 * and a fixed, safe line is said instead. It applies the same wording rules as
 * the verification gate for emails (no superlatives, no promises, no urgency,
 * no criticism of other clinics, no review numbers), plus what only matters on
 * a call: prices must be the published ones, and the agent never passes for a
 * person.
 */

export interface SpokenFlag {
  code: string;
  message: string;
}

export interface SpokenCheck {
  ok: boolean;
  /** What to say: the line, tidied for speech, or the fallback when it failed. */
  text: string;
  flags: SpokenFlag[];
}

export const FALLBACK_LINE =
  "I would rather not get that wrong, so I will leave that one to the report itself and to our team. What else can I walk you through?";

const MAX_CHARS = 700;

const REVIEW_NUMBER = /\b\d+(\.\d)?\s*(stars?|reviews?|ratings?)\b|\brated \d/i;
const HUMAN_CLAIM = /\b(i am|i'm|this is|you are speaking (to|with)|you're speaking (to|with)) (a |an )?(real |live |actual )?(person|human|human being)\b|\b(i am|i'm) not (a |an )?(ai|a\.i\.|robot|bot|machine|computer|recording)\b/i;
const DEAL = /\b(discounts?|\d+\s?(%|percent) off|coupons?|promo(tion)?s?|special (offer|price|deal)|free trial|money[- ]back|half price|sale price)\b/gi;
const CARD = /\b(card number|credit card|debit card|cvv|expiry date)\b/i;
const URL = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
/** "$200", "200 dollars", "200 CAD", "CAD 200", "200 bucks". */
const MONEY = /\$\s?(\d{1,6}(?:[.,]\d{1,2})?)|\b(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:cad\b|canadian dollars?|dollars?\b|bucks\b)|\bcad\s?(\d{1,6}(?:[.,]\d{1,2})?)/gi;

const PROMISE_CODES = new Set(["language_outcome_promise", "language_ranking_promise"]);
/** A clause that declines to promise or predict: "no one can say whether...", "I can't promise that...". */
const DISCLAIMS = /\b(no one|nobody|can't|cannot|can not|couldn't|could not|unable to|not able to|do not|don't|won't|will not|never|impossible to)\b[^,;]*\b(promise|guarantee|say|predict|tell|know|be sure|be certain)\b/i;

/** The text without its disclaiming clauses. A clause ends at a sentence end, a semicolon or a "but". */
export function withoutDisclaimers(text: string): string {
  return text.split(/(?<=[.?!])\s+|\s*;\s*|,?\s+but\s+/i).filter((clause) => !DISCLAIMS.test(clause)).join(" ");
}

/**
 * True when the line offers a discount or a deal. "There is no discount" and "I cannot offer a
 * discount" are the honest answer to a caller who asks for one, so a mention only counts when
 * nothing in its own clause negates it.
 */
function offersDeal(text: string): boolean {
  for (const m of text.matchAll(DEAL)) {
    const before = text.slice(0, m.index);
    const clause = before.slice(Math.max(...[",", ";", ".", "?", "!"].map((c) => before.lastIndexOf(c))) + 1);
    if (!/\bno\b|\bnot\b|n['’]t\b|\bnever\b|\bcannot\b|\bwithout\b|\bnor\b/i.test(clause)) return true;
  }
  return false;
}

/** Cut a long line at a sentence end: a caller should never listen to a paragraph. */
function clip(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const cut = text.slice(0, MAX_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > 200 ? cut.slice(0, end + 1) : cut;
}

export function checkSpoken(raw: string, brief: Pick<CallBrief, "allowedAmounts" | "names" | "quoted">): SpokenCheck {
  const flags: SpokenFlag[] = [];
  let text = clip(forSpeech(raw.replace(URL, "intheanswer dot c a")));
  if (!text) return { ok: false, text: FALLBACK_LINE, flags: [{ code: "empty", message: "nothing to say" }] };

  // The report's own lines (questions, quotes from the clinic's pages) and the names of clinics are
  // facts being repeated, not our wording: the scan skips them, exactly as the email gate does.
  const exclude = { names: brief.names, quoted: brief.quoted };
  // "I cannot promise your clinic will be recommended" is the opposite of a promise, and it is the
  // sentence a caller most needs to hear: a promise wording is only a breach outside such a clause.
  const promises = new Set(scanLanguage(withoutDisclaimers(text), "call", exclude).map((f) => f.code));
  for (const f of scanLanguage(text, "call", exclude)) {
    if (PROMISE_CODES.has(f.code) && !promises.has(f.code)) continue;
    flags.push({ code: f.code, message: f.message });
  }
  if (REVIEW_NUMBER.test(text)) flags.push({ code: "review_number", message: "review numbers are never spoken (Google Maps terms): they are only shown live on the web report" });
  if (HUMAN_CLAIM.test(text)) flags.push({ code: "human_claim", message: "the agent must never pass for a person" });
  if (offersDeal(text)) flags.push({ code: "invented_deal", message: "discounts and special offers do not exist" });
  if (CARD.test(text) && !/\b(never|not|no|don't|do not|cannot|can't)\b/i.test(text)) flags.push({ code: "payment_on_call", message: "payment is never taken on a call" });
  if (OWNER_PLACEHOLDER_RE.test(text)) flags.push({ code: "placeholder", message: "an owner detail is still a placeholder" });
  for (const m of text.matchAll(MONEY)) {
    const amount = Number((m[1] ?? m[2] ?? m[3]).replace(",", ""));
    if (!brief.allowedAmounts.includes(amount)) flags.push({ code: "price_not_published", message: `${amount} is not a published price` });
  }
  if (flags.length) return { ok: false, text: FALLBACK_LINE, flags };
  // tidy a trailing fragment left by clipping
  text = text.replace(/\s+$/, "");
  return { ok: true, text, flags: [] };
}

/** What a caller says when they want the calls, or all contact, to stop. Acted on without waiting for the model. */
const NO_CALLS = /\b(stop (calling|phoning)|do(n'?t| not) (ever )?(call|phone|ring) (me|us|here|this number|again|back|anymore|any more)|do(n'?t| not) (call|phone)[.!]?\s*$|never (call|phone) (me|us|here|this number|again|back)|quit calling|no more calls|take (me|us|this number|our number|my number) off (your|the) (call(ing)? |phone )?list|remove (me|us|this number|our number|my number) from|put (me|us|this number) on (your|the) do not call)\b/i;
const NO_CONTACT = /\b(do(n'?t| not) (ever )?contact (me|us)|stop contacting (me|us)|no (more|further) contact|unsubscribe (me|us)|stop (emailing|calling) (and|or) (calling|emailing))\b/i;

export function hearsOptOut(heard: string): "do_not_contact" | "do_not_call" | null {
  if (NO_CONTACT.test(heard)) return "do_not_contact";
  if (NO_CALLS.test(heard)) return "do_not_call";
  return null;
}
