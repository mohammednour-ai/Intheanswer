import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { computePriority, weakWebsite, nextToSend, reorder, updateClinicPriority } from "@/lib/sending/priority";
import { listMessages } from "@/lib/portal/queries";
import { resetData, makeClinic, makeMessage } from "./helpers";

const base = { recommended: 0, total: 6, reviews: null, site: null, hoursConflict: false, nameConflict: false, emailOnOwnSite: false };
const pass = (key: string) => ({ key, result: "pass", labOnly: false });
const bad = (key: string, labOnly = false) => ({ key, result: "needs_work", labOnly });

describe("send priority score", () => {
  it("adds the five weights", () => {
    const p = computePriority({
      recommended: 1, total: 6, reviews: { total: 12, average: 4.8 }, site: [bad("booking_path")], hoursConflict: true, nameConflict: false, emailOnOwnSite: true,
    });
    // few reviews +2, weak site +3, conflict +1, email +1 (not "strong": under 30 reviews)
    expect(p.score).toBe(7);
    const strong = computePriority({ ...base, reviews: { total: 80, average: 4.7 } });
    expect(strong.lines.find((l) => l.key === "strong_reviews_not_recommended")?.points).toBe(2);
    expect(computePriority({ ...base, recommended: 5, reviews: { total: 80, average: 4.7 } }).score).toBe(0);
    expect(computePriority({ ...base, reviews: { total: 80, average: 4.1 } }).score).toBe(0);
  });
  it("review lines are 'not available', not zero-by-fact, when no review numbers are stored", () => {
    const p = computePriority(base);
    expect(p.lines.filter((l) => !l.available).map((l) => l.key)).toEqual(["strong_reviews_not_recommended", "weak_website", "few_reviews"]);
    expect(p.score).toBe(0);
  });
  it("weak website: a patient-stopping failure, or three checks; lab-only speed does not count", () => {
    expect(weakWebsite([bad("mobile_layout"), pass("https")]).weak).toBe(true);
    expect(weakWebsite([bad("alt_text"), bad("titles_descriptions"), bad("heading_order")]).weak).toBe(true);
    expect(weakWebsite([bad("alt_text"), bad("speed_mobile", true), bad("speed_desktop", true)]).weak).toBe(false);
    expect(weakWebsite([pass("https")]).weak).toBe(false);
  });
});

describe("send order", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  async function clinicWith(name: string, score: number, over: Record<string, unknown> = {}, status = "approved") {
    const id = await makeClinic({ name, domain: `${name}.example`, priority_score: score });
    await makeMessage({ clinic_id: id, status, to_email: `info@${name}.example`, ...over });
    return id;
  }
  const order = async () => {
    const rows = await nextToSend(10);
    const names = await db()<{ id: string; name: string }[]>`select id, name from clinics`;
    return rows.map((r) => names.find((n) => n.id === r.clinic_id)!.name);
  };

  it("fills highest score first; nobody is excluded", async () => {
    await clinicWith("low", 1);
    await clinicWith("high", 7);
    await clinicWith("mid", 4);
    expect(await order()).toEqual(["high", "mid", "low"]);
  });

  it("a waiting item gains a point a week, so a low score is delayed, never dropped", async () => {
    await clinicWith("old", 1, { created_at: new Date(Date.now() - 29 * 86400e3) }); // 1 + 4 weeks = 5
    await clinicWith("fresh", 4);
    expect(await order()).toEqual(["old", "fresh"]);
  });

  it("hand order wins over score: top, up, down, and back to score", async () => {
    const low = await clinicWith("low", 1, {}, "pending_review");
    const high = await clinicWith("high", 7, {}, "pending_review");
    const mid = await clinicWith("mid", 4, {}, "pending_review");
    const names = async () => (await listMessages(["pending_review"])).map((m) => m.clinic_name);
    expect(await names()).toEqual(["high", "mid", "low"]);
    await reorder(low, "top");
    expect(await names()).toEqual(["low", "high", "mid"]);
    await reorder(mid, "up");
    expect(await names()).toEqual(["low", "mid", "high"]);
    await reorder(low, "down");
    expect(await names()).toEqual(["mid", "low", "high"]);
    for (const id of [low, mid, high]) await reorder(id, "reset");
    expect(await names()).toEqual(["high", "mid", "low"]);
  });

  it("is computed from stored audit and site test rows, with no lookups", async () => {
    const id = await makeClinic({ domain: "testdental.example" });
    await db()`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary) values (${id}, 'x@gmail.com', 'https://www.testdental.example/contact', false, true)`;
    const [audit] = await db()<{ id: string }[]>`insert into audits (clinic_id) values (${id}) returning id`;
    await db()`insert into audit_checks (audit_id, check_key, result, summary, is_gap) values (${audit.id}, 'hours_conflict', 'found', 's', true)`;
    const [run] = await db()<{ id: string }[]>`insert into site_test_runs (clinic_id, run_label, status, page_cap, finished_at) values (${id}, 't', 'done', 40, now()) returning id`;
    await db()`insert into site_test_checks (run_id, check_key, category, result, impact, line) values (${run.id}, 'booking_path', 'booking', 'needs_work', 100, 'l')`;
    const p = await updateClinicPriority(id, audit.id, 0, 6);
    expect(p.score).toBe(5); // weak site 3 + conflict 1 + email published on own site 1
    const [c] = await db()`select priority_score, jsonb_array_length(priority_breakdown) as n from clinics where id=${id}`;
    expect(c).toEqual({ priority_score: 5, n: 5 });
  });
});
