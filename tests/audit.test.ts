import { describe, expect, it } from "vitest";
import { SITE, siteFrom, HOME } from "./fixtures/site";
import {
  checkMetaDescription, checkStructuredData, checkAddressOnHome, checkContactEmail, checkAiCrawlers,
} from "@/lib/pipeline/audit/deterministic";
import { semanticChecks, type SemanticRead } from "@/lib/pipeline/audit/semantic";

const QUESTIONS = ["Who is accepting new patients?", "Who offers emergency visits?", "Which clinics list prices?"];
const emptyRead = (): SemanticRead => ({
  site_name: null, address: null, phone: null,
  questions: [],
  new_patients: { status: "not_stated", quote: "", url: "" },
  hours: { blocks: [], conflict: { exists: false, a: null, b: null, explanation: "" } },
  fees: { published: false, quotes: [] },
  insurance: { stated: false, direct_billing: "not_stated", quotes: [] },
  practitioners: { named: false, with_credentials: false, quotes: [] },
  languages: { stated: false, quotes: [] },
  areas_served: { stated: false, quotes: [] },
  outdated: [],
});
const ctx = { sector: "dental", questions: QUESTIONS, domain: "maplegrove.example" };
const get = (out: ReturnType<typeof semanticChecks>, k: string) => out.find((c) => c.key === k)!;

describe("site-only checks", () => {
  it("meta description", () => {
    expect(checkMetaDescription(SITE()).result).toBe("found");
    const none = siteFrom({ "https://x.example/": "<html><body>hi</body></html>" });
    const r = checkMetaDescription(none);
    expect(r).toMatchObject({ result: "not_found", isGap: true });
  });
  it("structured data must describe the business, from the raw source", () => {
    expect(checkStructuredData(SITE()).result).toBe("found");
    const webOnly = siteFrom({ "https://x.example/": `<html><head><script type="application/ld+json">{"@type":"WebSite"}</script></head><body>x</body></html>` });
    expect(checkStructuredData(webOnly)).toMatchObject({ result: "not_found", isGap: true });
  });
  it("address on the home page text (not only in structured data)", () => {
    expect(checkAddressOnHome(SITE()).result).toBe("found");
    const jsonOnly = siteFrom({
      "https://x.example/": `<html><head><script type="application/ld+json">{"@type":"Dentist","address":"12 Maple Street, Barrie, ON L4M 1A1"}</script></head><body>${"<p>Welcome to our friendly clinic where we care for your family.</p>".repeat(8)}</body></html>`,
    });
    expect(checkAddressOnHome(jsonOnly)).toMatchObject({ result: "not_found", isGap: true });
  });
  it("address check says could not verify when the page renders no text", () => {
    const empty = siteFrom({ "https://x.example/": "<html><body><div id=root></div></body></html>" });
    expect(checkAddressOnHome(empty).result).toBe("could_not_verify");
  });
  it("contact email domain", () => {
    expect(checkContactEmail(SITE(), { email: "info@maplegrove.example", sourceUrl: "u", onOwnDomain: true }).result).toBe("found");
    expect(checkContactEmail(SITE(), { email: "x@gmail.com", sourceUrl: "u", onOwnDomain: false })).toMatchObject({ result: "not_found", isGap: true });
  });
  it("AI crawlers: real blocks only, grouped user-agents share the general rules", () => {
    const blocked = checkAiCrawlers(SITE(), "User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin");
    expect(blocked).toMatchObject({ result: "not_found", isGap: true });
    expect(blocked.summary).toContain("ClaudeBot");
    const grouped = checkAiCrawlers(SITE(), "User-agent: GPTBot\nUser-agent: ClaudeBot\nUser-agent: *\nDisallow: /config\n");
    expect(grouped.result).toBe("found");
    expect(checkAiCrawlers(SITE(), "").result).toBe("found");
  });
});

describe("semantic checks keep only verified quotes", () => {
  it("a 'found' with a quote that is not on the page is not trusted", () => {
    const r = emptyRead();
    r.new_patients = { status: "accepting", quote: "We are always happy to welcome new families", url: "https://maplegrove.example/" };
    expect(get(semanticChecks(SITE(), r, ctx), "new_patients")).toMatchObject({ result: "not_found" });
    r.new_patients = { status: "accepting", quote: "We are accepting new patients.", url: "https://maplegrove.example/" };
    expect(get(semanticChecks(SITE(), r, ctx), "new_patients")).toMatchObject({ result: "found", isGap: false });
  });
  it("finds the real page when the model cites the wrong URL", () => {
    const r = emptyRead();
    r.new_patients = { status: "accepting", quote: "We are accepting new patients.", url: "https://maplegrove.example/fees" };
    const c = get(semanticChecks(SITE(), r, ctx), "new_patients");
    expect(c.evidence[0].url).toBe("https://maplegrove.example/");
  });
  it("hours conflict needs two exact, different quotes", () => {
    const r = emptyRead();
    r.hours.conflict = {
      exists: true,
      a: { quote: "Monday to Friday 9:00 am to 5:00 pm", url: "https://maplegrove.example/" },
      b: { quote: "Monday to Friday 8:00 am to 4:00 pm", url: "https://maplegrove.example/contact/" },
      explanation: "home says 9-5, contact says 8-4",
    };
    expect(get(semanticChecks(SITE(), r, ctx), "hours_conflict")).toMatchObject({ result: "found", isGap: true, severity: 90 });
    r.hours.conflict.b = { quote: "Monday to Friday 7:00 am to 3:00 pm", url: "https://maplegrove.example/contact/" };
    expect(get(semanticChecks(SITE(), r, ctx), "hours_conflict").result).toBe("could_not_verify");
  });
  it("fees need a dollar amount; outdated notices need a verified quote", () => {
    const r = emptyRead();
    r.fees = { published: true, quotes: [{ quote: "New patient exam and cleaning: $180.", url: "https://maplegrove.example/fees" }] };
    r.outdated = [{ quote: "masks are required in the clinic during the COVID-19 pandemic", url: "https://maplegrove.example/fees", reason: "pandemic-era rule" }];
    const out = semanticChecks(SITE(), r, ctx);
    expect(get(out, "fees").result).toBe("found");
    expect(get(out, "outdated_notices")).toMatchObject({ result: "found", isGap: true });
  });
  it("questions answered counts only verified answers and lists the rest", () => {
    const r = emptyRead();
    r.questions = [
      { index: 0, answered: true, quote: "We are accepting new patients.", url: "https://maplegrove.example/" },
      { index: 1, answered: true, quote: "Same-day emergencies welcome", url: "https://maplegrove.example/" },
    ];
    const c = get(semanticChecks(SITE(), r, ctx), "questions_answered");
    expect(c.summary).toMatch(/^1 of 3/);
    expect(c.findingText).toContain("Who offers emergency visits?");
    expect(c.isGap).toBe(true);
  });
  it("an unreadable site makes every semantic check could_not_verify, never not_found", () => {
    const empty = siteFrom({ "https://x.example/": "<html><body><div id=root></div></body></html>" });
    const out = semanticChecks(empty, emptyRead(), ctx);
    expect(out.every((c) => c.result === "could_not_verify" && !c.isGap)).toBe(true);
  });
  it("finding text says 'did not find', never 'missing'", () => {
    const out = semanticChecks(SITE(), emptyRead(), ctx);
    for (const c of out) if (c.findingText) expect(c.findingText).not.toMatch(/\bmissing\b|does not have/i);
  });
});

void HOME;
