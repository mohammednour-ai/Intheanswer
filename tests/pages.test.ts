import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { proposePages, planMonths, saveProposals } from "@/lib/pages/propose";
import { buildDraft, applyValues, type ClinicFacts } from "@/lib/pages/draft";
import { intentFor } from "@/lib/pages/intents";
import * as wf from "@/lib/pages/workflow";
import { resetData, makeClinic } from "./helpers";

// SYNTHETIC clinic.
const facts: ClinicFacts = {
  name: "Maple Grove Dental", city: "Barrie", sector: "dental", website: "https://maplegrove.example/",
  address: "12 Maple Street, Barrie, ON L4M 1A1", phone: null, hoursQuote: { text: "Monday to Friday 9:00 am to 5:00 pm", url: "https://maplegrove.example/" },
  regulatorNote: "Check all wording against the RCDSO advertising standards before publishing.",
};
const site = { pages: [
  { url: "https://maplegrove.example/", title: "Maple Grove Dental", h1: ["Welcome"], text: "We offer implants, whitening and cleanings. Call us." },
  { url: "https://maplegrove.example/emergency-dentist", title: "Emergency dentist", h1: ["Emergency care"], text: "Same day emergency visits." },
] };
const questions = [
  { index: 0, text: "Can you recommend a good dentist in Barrie that is accepting new patients?", status: "not_named" as const },
  { index: 1, text: "Which dentists in Barrie can see me the same day for a dental emergency?", status: "recommended" as const },
  { index: 2, text: "Which dental clinics in Barrie are affordable or list their prices?", status: "listed_only" as const },
];

describe("proposals", () => {
  it("proposes a page per uncovered or not-recommended question, and per offered service without a page", () => {
    const p = proposePages({ clinic: "Maple Grove Dental", city: "Barrie", sector: "dental", questions, site, competitorWords: [{ word: "implants", count: 3 }] });
    const intents = p.map((x) => x.intent);
    expect(intents).toContain("new_patients");
    expect(intents).toContain("cost");
    expect(intents).not.toContain("emergency"); // covered and recommended
    const services = p.filter((x) => x.kind === "service").map((x) => x.service);
    expect(services).toEqual(expect.arrayContaining(["Implants", "Whitening"]));
    expect(services).not.toContain("Braces"); // not offered on the site
    expect(p[0].intent).toBe("new_patients"); // not named + no page = highest priority
    expect(p[0].title).toBe("Is Maple Grove Dental accepting new patients in Barrie?");
  });
  it("plans pages_per_month pages per month", () => {
    expect(planMonths(5, 2, new Date("2026-11-11T00:00:00Z"))).toEqual(["2026-12", "2026-12", "2027-01", "2027-01", "2027-02"]);
  });
  it("detects intents from patient wording", () => {
    expect(intentFor("Which dentists bill my insurance directly so I do not pay up front?")?.intent).toBe("direct_billing");
    expect(intentFor("Are there dentists open evenings or Saturdays?")?.intent).toBe("hours");
  });
});

describe("drafts", () => {
  const d = buildDraft({ kind: "question", intent: "new_patients", targetQuestion: questions[0].text, service: null, title: "Is Maple Grove Dental accepting new patients in Barrie?" }, facts);
  it("title is the question, direct answer in two sentences, facts are placeholders", () => {
    expect(d.title).toMatch(/\?$/);
    expect(d.directAnswer).toHaveLength(2);
    expect(d.directAnswer[0]).toMatch(/\[YES OR NO/);
    expect(d.placeholders.length).toBeGreaterThan(3);
    expect(d.contact.address).toBe(facts.address); // confirmed on site
    expect(d.contact.phone).toBe("[PHONE]"); // not confirmed: placeholder
    expect(d.contact.hours).toBe(facts.hoursQuote!.text);
  });
  it("structured data matches the page type", () => {
    expect(d.jsonLd["@type"]).toBe("FAQPage");
    const s = buildDraft({ kind: "service", intent: "service", targetQuestion: "Where can I get implants in Barrie?", service: "Implants", title: "Implants at Maple Grove Dental in Barrie: what to expect" }, facts);
    expect(s.jsonLd["@type"]).toBe("MedicalWebPage");
    expect(wf.draftLanguageFlags(s)).toEqual([]);
  });
  it("prescription treatments get the no-promotion note; superlatives are flagged", () => {
    const b = buildDraft({ kind: "service", intent: "service", targetQuestion: "Botox", service: "Botox", title: "Botox at X" }, { ...facts, sector: "medspa" });
    expect(b.reviewerNotes.join(" ")).toMatch(/prescription treatment/);
    expect(wf.draftLanguageFlags({ ...d, details: ["We are the best clinic in Barrie."] })[0]).toMatch(/superlative/);
    expect(wf.draftLanguageFlags({ ...d, details: ["Faster than other clinics."] }).join(" ")).toMatch(/comparison/);
  });
  it("quotes and backslashes in clinic values cannot break or extend the structured data", () => {
    for (const v of ['Call "the front desk"', 'a", "injected": "yes', "back\\slash"]) {
      const f = applyValues(d, { [d.placeholders[1]]: v });
      expect(Object.keys(f.jsonLd).sort()).toEqual(Object.keys(d.jsonLd).sort());
      expect(JSON.stringify(f.jsonLd)).not.toContain('"injected":');
    }
    // keys that are not this draft's placeholders are ignored
    expect(applyValues(d, { "Maple Grove Dental": "Other Clinic" }).title).toBe(d.title);
  });
  it("clinic-entered values are escaped in the page HTML", () => {
    const f = applyValues(d, { "[HOW TO REGISTER: call, book online or visit]": "<script>alert(1)</script>" });
    expect(f.html).not.toContain("<script>alert");
    expect(f.html).toContain("&lt;script&gt;");
  });
});

describe("page workflow", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  async function newPage() {
    const clinicId = await makeClinic({ name: "Maple Grove Dental" });
    const p = proposePages({ clinic: "Maple Grove Dental", city: "Barrie", sector: "dental", questions, site, competitorWords: [] });
    const [id] = await saveProposals(clinicId, p.slice(0, 1), 2);
    return id;
  }
  const events = async (id: string) => (await db()`select from_status::text, to_status::text, actor from answer_page_events where page_id=${id} order by id`).map((e) => `${e.from_status ?? "new"}>${e.to_status}:${e.actor}`);

  it("draft -> owner review -> clinic approval by link -> live, every step recorded", async () => {
    const id = await newPage();
    const d = await wf.generateDraft(id, facts);
    await wf.ownerApprove(id, "owner@example.com");
    const token = await wf.sendToClinic(id, "owner@example.com");
    expect(token.length).toBeGreaterThanOrEqual(22);
    const values = Object.fromEntries(d.placeholders.map((p) => [p, "Confirmed"]));
    await wf.clinicApprove(token, values, "Office manager");
    await wf.markLive(id, "https://maplegrove.example/new-patients", "owner@example.com");
    const [p] = await db()`select status::text, live_url from answer_pages where id=${id}`;
    expect(p).toEqual({ status: "live", live_url: "https://maplegrove.example/new-patients" });
    expect(await events(id)).toEqual([
      "new>proposed:system", "proposed>draft:system", "draft>owner_reviewed:owner", "owner_reviewed>sent_to_clinic:owner",
      "sent_to_clinic>clinic_approved:clinic", "clinic_approved>live:owner",
    ]);
    const [v] = await db()`select max(version)::int as v from answer_page_versions where page_id=${id}`;
    expect(v.v).toBe(2); // the clinic's filled-in version
  });

  it("refuses skipped steps, wrong actors and going live with placeholders left", async () => {
    const id = await newPage();
    await expect(wf.ownerApprove(id, "o")).rejects.toThrow(/cannot move from proposed/);
    await wf.generateDraft(id, facts);
    await expect(wf.sendToClinic(id, "o")).rejects.toThrow(/cannot move from draft to sent_to_clinic/);
    await wf.ownerApprove(id, "o");
    const token = await wf.sendToClinic(id, "o");
    await wf.clinicApprove(token, {}, "Office manager");
    await expect(wf.markLive(id, "https://x.example/p", "o")).rejects.toThrow(/placeholder/);
    await expect(wf.markLive(id, "not a url", "o")).rejects.toThrow(/https/);
  });

  it("clinic can ask for changes, which sends the page back to draft", async () => {
    const id = await newPage();
    await wf.generateDraft(id, facts);
    await wf.ownerApprove(id, "o");
    const token = await wf.sendToClinic(id, "o");
    await wf.clinicRequestChanges(token, "We stopped Saturday hours", "Dr. A");
    await expect(wf.clinicApprove(token, {}, "x")).rejects.toThrow(/cannot move from changes_requested/);
    const d = (await db()`select content from answer_page_versions where page_id=${id} order by version desc limit 1`)[0].content;
    await wf.ownerEdit(id, d, "o");
    expect((await db()`select status::text from answer_pages where id=${id}`)[0].status).toBe("draft");
  });

  it("clinic wording that breaks the rules is refused", async () => {
    const id = await newPage();
    const d = await wf.generateDraft(id, facts);
    await wf.ownerApprove(id, "o");
    const token = await wf.sendToClinic(id, "o");
    await expect(wf.clinicApprove(token, { [d.placeholders[0]]: "the best dentist in Barrie" }, "x")).rejects.toThrow(/rules/);
  });
});
