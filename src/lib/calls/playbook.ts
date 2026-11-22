import { PILLARS, PROMISES, REVIEWS_BRIDGE, POSITIONING_SHORT, TIERS, readBack, reassurance, type OnlineTier, type PillarKey, type Switches } from "../offer";
import { isBusinessDay, localParts } from "../time";

/**
 * The call playbook: the order a call follows and the rules that are enforced
 * by the program, not left to the model's judgement.
 *
 *   1 opening      who is calling, that it is an AI, that the call is transcribed, one ice-breaker
 *   2 role         is this the owner or manager? if not, reach that person instead of selling
 *   3 facts        the clinic's own results, one at a time
 *   4 discovery    two or three questions to find the problem the clinic actually feels
 *   5 bridge       one or two things we do that answer that problem, never a list
 *   6 reassurance  one sentence, once, only when interest is clear, in the published words
 *   7 offer        the plan that fits, then one next step; the decision is theirs
 *   8 close        one sentence on what happens next
 *
 * What the model reports each turn (stage, the pains it heard, a buying signal)
 * is kept on the call and checked here; the after-call review then reads the
 * transcript to see that what it reported is what the caller said.
 */

export const STAGES = ["opening", "role", "facts", "discovery", "bridge", "reassurance", "offer", "close"] as const;
export type Stage = (typeof STAGES)[number];
export const stageRank = (s: Stage | null | undefined) => (s ? STAGES.indexOf(s) : -1);

/** The problems discovery listens for. Each one points to the part of the service that answers it. */
export const PAINS = ["missed_calls", "old_website", "reviews", "too_many_vendors", "not_in_ai_answers"] as const;
export type Pain = (typeof PAINS)[number];

export const PAIN_PILLAR: Record<Pain, PillarKey> = {
  missed_calls: "front_desk",
  reviews: "front_desk",
  old_website: "website",
  too_many_vendors: "systems",
  not_in_ai_answers: "found",
};

/** The discovery questions. The agent asks two or three, chosen by what the report showed. */
export const DISCOVERY: { pain: Pain; question: string }[] = [
  { pain: "not_in_ai_answers", question: "How do most new patients find you today?" },
  { pain: "missed_calls", question: "What happens when someone calls after hours or when the front desk is busy?" },
  { pain: "old_website", question: "When was your website last rebuilt, and who looks after it?" },
  { pain: "reviews", question: "How do you ask patients for reviews now, and who replies to them?" },
  { pain: "too_many_vendors", question: "How many different companies handle your website, phones, booking and marketing?" },
];

/** The one sentence that connects a pain to what we do. */
export function bridgeFor(pain: Pain): string {
  return pain === "reviews" ? REVIEWS_BRIDGE : PILLARS[PAIN_PILLAR[pain]].bridge;
}

/** Pains whose pillar is switched on: a pillar that is off is not discovered for and not bridged to. */
export function painsOffered(s: Switches): Pain[] {
  return PAINS.filter((p) => s.pillars.includes(PAIN_PILLAR[p]));
}

// ---------------------------------------------------------------------------
// The opening: one ice-breaker from the approved set, chosen by the program
// ---------------------------------------------------------------------------

export const ICE_BREAKERS = {
  call_me: "Thanks for asking us to call. I'll keep it to a few minutes.",
  inbound: "Thanks for calling in. Happy to walk you through your results.",
  inbound_unknown: "Thanks for calling in.",
  reply: "Thanks for your reply the other day. This should be quick.",
  morning: "Thanks for making time this morning.",
  end_of_day: "Thanks for taking this at the end of the day.",
} as const;

/**
 * Exactly one line, by context: how the call came about first, the time of
 * day otherwise. `source` is the consent the call rests on (call_consents.source).
 */
export function iceBreaker(ctx: { direction: "inbound" | "outbound"; source?: string | null; clinicKnown?: boolean; now?: Date }): string {
  if (ctx.direction === "inbound") return ctx.clinicKnown ? ICE_BREAKERS.inbound : ICE_BREAKERS.inbound_unknown;
  if (ctx.source === "email_reply") return ICE_BREAKERS.reply;
  if (ctx.source === "web_form") return ICE_BREAKERS.call_me;
  const now = ctx.now ?? new Date();
  const { hour, minute } = localParts(now);
  const minutes = hour * 60 + minute;
  if (isBusinessDay(now) && minutes < 11 * 60) return ICE_BREAKERS.morning;
  if (isBusinessDay(now) && minutes >= 15 * 60 + 30) return ICE_BREAKERS.end_of_day;
  return ICE_BREAKERS.call_me;
}

// ---------------------------------------------------------------------------
// What the spoken-word check enforces from the playbook
// ---------------------------------------------------------------------------

/**
 * The words that name a part of the service beyond the report itself. A line
 * that uses them is selling that part, which the playbook allows only when
 * the caller's own answer pointed to it (or they asked what a plan includes).
 * Being found by AI assistants is what every call is about, so it has no gate.
 */
export const PILLAR_WORDS: Partial<Record<PillarKey, RegExp>> = {
  front_desk: /\b(receptionist|after[- ]hours|overflow calls?|missed calls?|answers? (your|the) (phones?|calls)|review requests?|reply drafts?|reminders?|booking automation)\b/i,
  website: /\b(rebuil[dt]\w*|re-?design\w*|new (web)?site|(web)?site (rebuild|care)|take over (your|the) (web)?site)\b/i,
  systems: /\b(integrat\w+|practice management|custom tools?|one partner|connect(ed|ing)? (your |the )?(booking|phone|forms|systems))\b/i,
};

/** A gated pillar may be named at most this many times in different pillars per call: a match, not a catalogue. */
export const MAX_PILLARS_PER_CALL = 2;

/**
 * Support, warranty and security are promises with exact wording. Any other
 * way of saying them is stopped: the published sentence is the only one we
 * can be held to.
 */
const PROMISE_WORDS = /\b(24\s?\/\s?7|around the clock|twenty[- ]four|within (1|one|an?) (business )?(hour|day)|business hours?|warrant(y|ies|ied)|fixed (for )?free|free of charge|daily backups?|backed up|uptime|two[- ]factor)\b/i;

/** Sentences the program publishes itself and the agent may repeat as they are. */
export function fixedSentences(s: Switches): string[] {
  const on = s.promises.map((k) => PROMISES[k]);
  return [reassurance(s) ?? "", ...on.map((p) => p.text), ...on.map((p) => p.spoken), POSITIONING_SHORT].filter(Boolean);
}

export interface PlaybookState {
  /** Pains on record for this call, including any the model reports on this turn. */
  pains: Pain[];
  /** The caller asked about price, what is included, or how to start (now or earlier). */
  buyingSignal: boolean;
  /** The caller has said "not now" to the offer. */
  declined: boolean;
  /** Gated pillars already named on this call. */
  pillarsNamed: PillarKey[];
  reassured: boolean;
}

export interface PlaybookFlag {
  code: "pillar_without_pain" | "too_many_pillars" | "promise_wording" | "reassurance_twice" | "offer_after_no";
  message: string;
}

const strip = (text: string, sentences: string[]) =>
  sentences.reduce((t, s) => t.split(s).join(" "), text);

/**
 * The part of a line that describes what we do. A question about the clinic ("What happens when
 * someone calls after hours?", "When was your website last rebuilt?") is discovery: it uses the same
 * words as the service but offers nothing, so it is left out. A question that speaks of us ("Shall
 * we set up an AI receptionist?") is an offer and stays in.
 */
function offering(text: string): string {
  return text
    .split(/(?<=[.?!])\s+/)
    .filter((sentence) => !(/\?\s*$/.test(sentence) && !/\b(we|we'll|we'd|we've|our|us|i can|i could|i'll)\b/i.test(sentence)))
    .join(" ");
}

const MONEY = /\$\s?\d|\b\d{2,6}\s*(dollars?|cad|bucks)\b/i;

/**
 * Check one line the model wants to say against the playbook. Returns the
 * rules it breaks (none: say it) and the gated pillars it names.
 */
export function checkPlaybook(text: string, st: PlaybookState, s: Switches): { flags: PlaybookFlag[]; pillars: PillarKey[] } {
  const flags: PlaybookFlag[] = [];
  const fixed = fixedSentences(s);
  const line = reassurance(s);
  const saysReassurance = !!line && text.includes(line);
  if (saysReassurance && st.reassured) flags.push({ code: "reassurance_twice", message: "the reassurance sentence is said once per call" });

  const own = strip(text, fixed);
  if (PROMISE_WORDS.test(own)) flags.push({ code: "promise_wording", message: "support, warranty and security are stated only in their published wording" });

  const offered = offering(own);
  const named = (Object.keys(PILLAR_WORDS) as PillarKey[]).filter((k) => PILLAR_WORDS[k]!.test(offered));
  const allowed = new Set(st.pains.map((p) => PAIN_PILLAR[p]));
  for (const k of named) {
    if (!s.pillars.includes(k)) flags.push({ code: "pillar_without_pain", message: `"${PILLARS[k].title}" is not offered right now` });
    else if (!st.buyingSignal && !allowed.has(k)) flags.push({ code: "pillar_without_pain", message: `"${PILLARS[k].title}" was named, but nothing the caller said points to it` });
  }
  const total = new Set([...st.pillarsNamed, ...named]);
  if (!st.buyingSignal && total.size > MAX_PILLARS_PER_CALL && named.some((k) => !st.pillarsNamed.includes(k))) {
    flags.push({ code: "too_many_pillars", message: `more than ${MAX_PILLARS_PER_CALL} parts of the service named on one call` });
  }
  if (st.declined && !st.buyingSignal && MONEY.test(text)) flags.push({ code: "offer_after_no", message: "the caller said not now: no second offer" });
  return { flags, pillars: named };
}

// ---------------------------------------------------------------------------
// The buying step: the program's own lines
// ---------------------------------------------------------------------------

export { readBack };

/** What the agent says once the caller has said yes to the read-back and the link is on its way. */
export function linkSent(plan: OnlineTier): string {
  const after =
    plan === "growth" ? "After checkout there's a short form about your website, and your first monthly report comes about 30 days later."
    : plan === "visibility" ? "After checkout we'll write to arrange access to your site, and your first monthly report comes about 30 days later."
    : "The report is checked first, then it's emailed to you.";
  return `Done. The secure checkout link is on its way, with ${TIERS[plan].inSentence}, the price and the terms in writing. ${after} Is there anything else I can explain?`;
}

export const BUYING_LINES = {
  reportSent: "Done. I've sent the report to the address it first went to. Is there anything else I can explain?",
  summaryComing: "Of course. We'll email you a short summary of today's call and the plans. Take your time. Is there anything else I can explain?",
  noAddress: (owner: string) => `I don't have an email address on file for you, so ${owner} will follow up with you directly. Is there anything else I can explain?`,
  changeByEmail: (owner: string) => `Since you're already on a plan, the change is arranged by email so you're not charged twice. ${owner} will write to you about it. Is there anything else I can explain?`,
  quoteCallback: (owner: string) => `That one is quoted after a short review, so ${owner} will call you to go through it. Is there anything else I can explain?`,
  afterNo: "Of course. Is there anything else in the report I can explain?",
  silenceSummary: "I can't hear anyone, so I'll end the call here and we'll email you a summary. Goodbye.",
} as const;
