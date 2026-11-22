import { describe, expect, it } from "vitest";
import {
  DEFAULT_SWITCHES, LEGACY_PLAN, NEVER_PROMISED, ONLINE_TIERS, PILLARS, PILLAR_ORDER, POSITIONING, POSITIONING_SHORT, PROMISES, PROMISE_ORDER,
  REPORT_CREDIT, REPORT_CREDIT_TEXT, REVIEWS_BRIDGE, TIERS, TIER_ORDER,
  emailOfferLines, firstPaymentCents, isOnlineTier, isSubscriptionTier, isTierKey, offeredTo, phoneOfferLines, pillarsOn, planName, priceAnswer, priceText,
  promisesOn, readBack, readSwitches, reassurance, speakableAmounts, spokenPrice, termText, tierIncludes, type Switches,
} from "@/lib/offer";
import { scanLanguage } from "@/lib/pipeline/verify";
import { checkSpoken } from "@/lib/calls/guard";

const ALL: Switches = { promises: [...PROMISE_ORDER], pillars: [...PILLAR_ORDER] };
/** The promises are fixed wording: a surface that scans its text leaves them out, as it does names and quotes. */
const fixed = { quoted: PROMISE_ORDER.flatMap((k) => [PROMISES[k].text, PROMISES[k].spoken]) };

describe("the offer", () => {
  it("has the published plans, prices and terms", () => {
    expect(TIER_ORDER).toEqual(["report", "visibility", "growth", "transformation"]);
    expect(priceText("report")).toBe("200 CAD, one time");
    expect(priceText("visibility")).toBe("200 CAD a month");
    expect(priceText("growth")).toBe("450 CAD a month, plus 500 CAD setup");
    expect(priceText("transformation")).toBe("from 900 CAD a month, quoted after a review");
    expect(termText("report")).toBe("no contract");
    expect(termText("visibility")).toBe("month to month");
    expect(termText("growth")).toBe("6-month minimum, then month to month");
    expect(termText("transformation")).toBe("6-month minimum, then month to month");
    expect(ONLINE_TIERS).toEqual(["report", "visibility", "growth"]);
    expect(TIERS.transformation.purchase).toBe("quote");
  });

  it("works out the first payment, with the setup amount and the report credit", () => {
    expect(firstPaymentCents("report")).toBe(20000);
    expect(firstPaymentCents("visibility")).toBe(20000);
    expect(firstPaymentCents("growth")).toBe(95000);
    expect(REPORT_CREDIT).toEqual({ cents: 20000, days: 30 });
    expect(firstPaymentCents("growth", REPORT_CREDIT.cents)).toBe(75000);
    expect(firstPaymentCents("visibility", REPORT_CREDIT.cents)).toBe(0);
    // the credit is for a plan, never for a second report
    expect(firstPaymentCents("report", REPORT_CREDIT.cents)).toBe(20000);
  });

  it("knows a plan key from anything else, and which plans are bought online", () => {
    expect(isTierKey("growth")).toBe(true);
    expect(isTierKey("monthly")).toBe(false);
    expect(isTierKey("constructor")).toBe(false);
    expect(isOnlineTier("transformation")).toBe(false);
    expect(isOnlineTier("visibility")).toBe(true);
    expect(isSubscriptionTier("report")).toBe(false);
    expect(isSubscriptionTier("transformation")).toBe(true);
  });

  it("maps the retired plans to Visibility, and never offers a clinic what it has", () => {
    expect(LEGACY_PLAN).toEqual({ monthly: "visibility", reports: "visibility" });
    expect(planName("growth")).toBe("Growth");
    expect(planName("monthly")).toBe("Full service plan (retired)");
    expect(offeredTo(null)).toEqual(TIER_ORDER);
    expect(offeredTo("report")).toEqual(["visibility", "growth", "transformation"]);
    expect(offeredTo("visibility")).toEqual(["growth", "transformation"]);
    expect(offeredTo("monthly")).toEqual(["growth", "transformation"]);
    expect(offeredTo("transformation")).toEqual([]);
  });

  it("states only the promises and pillars that are switched on", () => {
    expect(DEFAULT_SWITCHES.promises).toEqual(["support", "changes", "warranty", "ownership", "terms"]);
    expect(promisesOn().map((p) => p.key)).not.toContain("security");
    expect(readSwitches(null)).toEqual(DEFAULT_SWITCHES);
    expect(readSwitches({ promises: ["security", "nonsense", "support"], pillars: [] })).toEqual({ promises: ["support", "security"], pillars: [] });
    const noFrontDesk: Switches = { promises: [], pillars: ["found", "website", "proof"] };
    expect(pillarsOn(noFrontDesk).map((p) => p.key)).toEqual(["found", "website", "proof"]);
    expect(tierIncludes("growth", noFrontDesk).join(" ")).not.toMatch(/receptionist|Review requests/);
    expect(tierIncludes("growth", noFrontDesk).join(" ")).toMatch(/website rebuilt/);
    expect(tierIncludes("growth", ALL).join(" ")).toMatch(/receptionist/);
    expect(reassurance(noFrontDesk)).toBeNull();
    expect(reassurance()).toBe("Everything is covered in the plan: support around the clock for urgent issues, changes within a business day, anything we build is fixed free while you're with us, you own your site and data, and after the minimum term it's month to month.");
  });

  it("writes one line per plan for an email, with its checkout link", () => {
    const lines = emailOfferLines({ buyBase: "https://intheanswer.ca/buy/tok" });
    expect(lines).toEqual([
      "- Full report and fix files: 200 CAD, one time. Every finding with its fix, for your own web person to install. https://intheanswer.ca/buy/tok/report",
      "- Visibility: 200 CAD a month. We publish the answer pages, fix the listings and retest every month. https://intheanswer.ca/buy/tok/visibility",
      "- Growth: 450 CAD a month, plus 500 CAD setup. Everything in Visibility, plus a rebuilt website that we keep current and an AI receptionist for missed calls. https://intheanswer.ca/buy/tok/growth",
    ]);
    expect(emailOfferLines({ has: "visibility" })).toHaveLength(1);
    expect(emailOfferLines({ withQuote: true })).toHaveLength(4);
    expect(priceAnswer(true)).toContain("450 CAD a month, plus 500 CAD setup");
    expect(priceAnswer(true)).toContain("credited to your first month");
    expect(priceAnswer(false)).not.toContain("HST");
  });
});

describe("the offer's wording", () => {
  const sentences = [
    POSITIONING, POSITIONING_SHORT, NEVER_PROMISED, REPORT_CREDIT_TEXT, REVIEWS_BRIDGE, priceAnswer(true),
    ...TIER_ORDER.flatMap((k) => [TIERS[k].name, TIERS[k].summary, TIERS[k].action, TIERS[k].whoDoesIt, TIERS[k].retests, priceText(k), termText(k), ...tierIncludes(k, ALL)]),
    ...PILLAR_ORDER.flatMap((k) => [PILLARS[k].title, PILLARS[k].text, PILLARS[k].bridge]),
    ...PROMISE_ORDER.flatMap((k) => [PROMISES[k].title, PROMISES[k].text]),
    ...emailOfferLines({ withQuote: true }),
    ...phoneOfferLines(null, ALL),
  ];

  it("passes the same wording rules as every email: no superlative, no promised result, no pressure", () => {
    for (const s of sentences) expect(scanLanguage(s, "offer", fixed), s).toEqual([]);
  });
  it("never promises a result", () => {
    const all = sentences.join(" ");
    expect(all).not.toMatch(/\b(will|would) (be )?(named|recommended|ranked|appear|show up)\b/i);
    expect(all).not.toMatch(/more patients|more revenue|first page|rank higher/i);
    expect(NEVER_PROMISED).toMatch(/not guaranteed/);
  });
  it("is the only place the word 'urgent' is allowed: inside the support promise", () => {
    const raw = sentences.filter((s) => scanLanguage(s, "offer").length > 0);
    expect(raw).toEqual([PROMISES.support.text]);
  });
});

describe("the offer on the phone", () => {
  const brief = { allowedAmounts: speakableAmounts(), names: [], quoted: fixed.quoted };

  it("may say the published prices, and never the Transformation one", () => {
    expect(speakableAmounts()).toEqual([200, 450, 500]);
    expect(spokenPrice("growth")).toBe("450 dollars a month plus 500 dollars setup, with a 6-month minimum, then month to month");
    expect(spokenPrice("visibility")).toBe("200 dollars a month, month to month");
    expect(spokenPrice("transformation")).not.toMatch(/\d/);
    expect(phoneOfferLines(null).find((l) => l.startsWith("Transformation"))).not.toMatch(/900/);
    expect(checkSpoken("Transformation starts at 900 dollars a month.", brief).ok).toBe(false);
  });
  it("has a read-back for each plan bought online, built from the published price and term", () => {
    expect(readBack("growth")).toBe("Just to confirm: the Growth plan, 450 dollars a month plus 500 dollars setup, with a 6-month minimum, then month to month. I'll email the checkout link to the address your report was sent to. Is that right?");
    for (const k of ONLINE_TIERS) expect(checkSpoken(readBack(k), brief), k).toMatchObject({ ok: true });
  });
  it("has bridge and reassurance lines that pass the spoken-word check", () => {
    const spoken = [...PILLAR_ORDER.map((k) => PILLARS[k].bridge), REVIEWS_BRIDGE, POSITIONING_SHORT, reassurance(ALL)!, ...ONLINE_TIERS.map((k) => `It is ${spokenPrice(k)}.`)];
    for (const s of spoken) expect(checkSpoken(s, brief), s).toMatchObject({ ok: true });
    // the same promise in other words is not the promise: it is stopped
    expect(checkSpoken("We answer urgent problems right away, day or night.", brief).ok).toBe(false);
  });
});
