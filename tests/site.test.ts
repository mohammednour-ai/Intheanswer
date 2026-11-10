import { describe, expect, it } from "vitest";
import { parsePage, textContains } from "@/lib/site/parse";
import { findContacts, emailOnDomain } from "@/lib/pipeline/contact";
import { decidePlace } from "@/lib/pipeline/discover";
import { HOME, SITE, siteFrom } from "./fixtures/site";

describe("page parsing", () => {
  it("extracts visible text, meta description, JSON-LD and links", () => {
    const p = parsePage("https://maplegrove.example/", HOME);
    expect(p.title).toBe("Maple Grove Dental | Barrie");
    expect(p.metaDescription).toMatch(/family dental clinic/);
    expect(p.jsonLd[0].types).toEqual(["Dentist"]);
    expect(p.text).toContain("accepting new patients");
    expect(p.text).not.toContain(".x{color");
    expect(p.links.map((l) => l.href)).toContain("https://maplegrove.example/contact/");
  });
  it("finds emails from mailto and text, and drops junk", () => {
    const site = SITE();
    const all = site.pages.flatMap((p) => p.emails.map((e) => e.email));
    expect(all).toEqual(expect.arrayContaining(["info@maplegrove.example", "hello@maplegrove.example", "office.manager@gmail.com"]));
    expect(all.some((e) => e.includes("@2x.png"))).toBe(false);
  });
  it("matches quotes regardless of whitespace, case and curly quotes", () => {
    expect(textContains("We’re  accepting\nnew patients", "we're accepting new patients")).toBe(true);
    expect(textContains("accepting new patients", "not accepting")).toBe(false);
  });
});

describe("contact finding", () => {
  it("prefers a generic address on the clinic's own domain and keeps the exact source URL", () => {
    const r = findContacts(SITE());
    expect(r.primary?.email).toBe("info@maplegrove.example");
    expect(r.primary?.sourceUrl).toBe("https://maplegrove.example/");
    expect(r.primary?.onOwnDomain).toBe(true);
    expect(r.doNotContact).toBeNull();
  });
  it("never invents an address when none is published", () => {
    const r = findContacts(siteFrom({ "https://x.example/": "<html><body><p>Call us at 705-555-0100.</p></body></html>" }));
    expect(r.primary).toBeNull();
    expect(r.candidates).toEqual([]);
  });
  it("marks do-not-contact on a no-solicitation notice", () => {
    const r = findContacts(
      siteFrom({ "https://x.example/": "<html><body><p>info@x.example</p><p>Please note: no solicitations. Vendors please do not email.</p></body></html>" }),
    );
    expect(r.doNotContact?.url).toBe("https://x.example/");
    expect(r.doNotContact?.quote).toMatch(/no solicitations/i);
  });
  it("own-domain test handles subdomains", () => {
    expect(emailOnDomain("a@mail.maplegrove.example", "maplegrove.example")).toBe(true);
    expect(emailOnDomain("a@maplegrove.example.evil.com", "maplegrove.example")).toBe(false);
  });
});

describe("discovery filters", () => {
  const chains = ["dentalcorp", "appletree"];
  const counts = new Map<string, number>();
  const base = { id: "p1", displayName: { text: "Maple Grove Dental" }, websiteUri: "https://maplegrove.example/", formattedAddress: "12 Maple St, Barrie, ON", businessStatus: "OPERATIONAL" };
  it("keeps an independent clinic with its own website", () => {
    expect(decidePlace(base, chains, counts, "Barrie")).toMatchObject({ include: true, domain: "maplegrove.example" });
  });
  it("skips businesses without their own website", () => {
    expect(decidePlace({ ...base, websiteUri: undefined }, chains, counts, "Barrie").include).toBe(false);
    expect(decidePlace({ ...base, websiteUri: "https://www.facebook.com/maplegrove" }, chains, counts, "Barrie").include).toBe(false);
    expect(decidePlace({ ...base, websiteUri: "https://maplegrove.janeapp.com" }, chains, counts, "Barrie").include).toBe(false);
  });
  it("skips chains by name, shared domain or location page", () => {
    expect(decidePlace({ ...base, displayName: { text: "Appletree Medical Centre" } }, chains, counts, "Barrie").include).toBe(false);
    expect(decidePlace(base, chains, new Map([["maplegrove.example", 3]]), "Barrie").include).toBe(false);
    expect(decidePlace({ ...base, websiteUri: "https://brand.example/locations/barrie" }, chains, counts, "Barrie").include).toBe(false);
  });
  it("skips closed businesses", () => {
    expect(decidePlace({ ...base, businessStatus: "CLOSED_PERMANENTLY" }, chains, counts, "Barrie").include).toBe(false);
  });
});
