import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { submitSelfServe, normalizeWebsite } from "@/lib/selfServe";
import { unsubscribe } from "@/lib/unsubscribe";
import { isSuppressed, addSuppression } from "@/lib/sending/suppression";
import { unsubscribeToken, verifyUnsubscribeToken } from "@/lib/tokens";
import { resetData, makeClinic, makeMessage } from "./helpers";

const base = { website: "maplegrove.example", email: "info@maplegrove.example", sector: "dental", city: "orillia", ip: "203.0.113.5" };

describe("self-serve box", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  it("normalises the website to its https home page", () => {
    expect(normalizeWebsite("MapleGrove.example/contact?x=1")).toBe("https://maplegrove.example/");
    expect(normalizeWebsite("http://www.maplegrove.example")).toBe("https://www.maplegrove.example/");
    expect(normalizeWebsite("not a site")).toBeNull();
  });

  it("creates a self-serve clinic and starts the same pipeline", async () => {
    const r = await submitSelfServe(base);
    expect(r.ok).toBe(true);
    const [c] = await db()`select c.source, c.domain, ci.name as city from clinics c join cities ci on ci.id=c.city_id`;
    expect(c).toEqual({ source: "self_serve", domain: "maplegrove.example", city: "Orillia" });
    const [j] = await db()`select kind from jobs`;
    expect(j.kind).toBe("find_contact");
    const [q] = await db()`select status, email from self_serve_requests`;
    expect(q).toEqual({ status: "received", email: "info@maplegrove.example" });
  });

  it("rejects bad input and private or own addresses", async () => {
    expect((await submitSelfServe({ ...base, email: "nope" })).ok).toBe(false);
    expect((await submitSelfServe({ ...base, sector: "plumber" })).ok).toBe(false);
    expect((await submitSelfServe({ ...base, website: "http://192.168.1.10" })).ok).toBe(false);
    expect((await submitSelfServe({ ...base, website: "intheanswer.ca" })).ok).toBe(false);
    expect((await submitSelfServe({ ...base, city: "<script>" })).ok).toBe(false);
    expect((await db()`select count(*)::int as n from jobs`)[0].n).toBe(0);
  });

  it("limits requests per visitor per day and per site", async () => {
    for (let i = 0; i < 3; i++) expect((await submitSelfServe({ ...base, website: `site${i}.example`, email: `a@site${i}.example` })).ok).toBe(true);
    const fourth = await submitSelfServe({ ...base, website: "site9.example", email: "a@site9.example" });
    expect(fourth.ok).toBe(false);
    const again = await submitSelfServe({ ...base, ip: "203.0.113.99", website: "site0.example", email: "a@site0.example" });
    expect(again.message).toMatch(/requested recently/);
    expect((await db()`select count(*)::int as n from jobs`)[0].n).toBe(3);
  });

  it("does nothing for a filled honeypot or a suppressed address, with the same reply", async () => {
    const ok = await submitSelfServe(base);
    await resetData();
    const bot = await submitSelfServe({ ...base, honeypot: "Acme" });
    await addSuppression("address", base.email, "unsubscribed", "test");
    const sup = await submitSelfServe(base);
    expect(bot.message).toBe(ok.message);
    expect(sup.message).toBe(ok.message);
    expect((await db()`select count(*)::int as n from jobs`)[0].n).toBe(0);
  });
});

describe("unsubscribe", () => {
  beforeEach(resetData);

  it("works from the signed link without login: suppresses, cancels unsent mail, closes the clinic", async () => {
    const clinic = await makeClinic({ status: "queued" });
    await db()`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary) values (${clinic}, 'info@testdental.example', 'https://testdental.example/', true, true)`;
    const pending = await makeMessage({ clinic_id: clinic });
    const sent = await makeMessage({ clinic_id: clinic, status: "sent" });
    const email = verifyUnsubscribeToken(unsubscribeToken("Info@TestDental.example"));
    await unsubscribe(email!, "unsubscribe_link");
    expect((await isSuppressed("info@testdental.example")).suppressed).toBe(true);
    const rows = await db()`select id, status::text from messages where id in (${pending}, ${sent})`;
    expect(rows.find((r) => r.id === pending)?.status).toBe("cancelled");
    expect(rows.find((r) => r.id === sent)?.status).toBe("sent");
    expect((await db()`select status::text from clinics where id=${clinic}`)[0].status).toBe("suppressed");
  });

  it("is safe to repeat and ignores invalid input", async () => {
    await unsubscribe("a@b.example", "unsubscribe_form");
    await unsubscribe("a@b.example", "one_click");
    await unsubscribe("not-an-email", "unsubscribe_form");
    expect((await db()`select count(*)::int as n from suppressions`)[0].n).toBe(1);
  });
});
