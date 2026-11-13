import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, closeDb } from "@/lib/db";
import { submitSelfServe, normalizeWebsite, runHeldSelfServe } from "@/lib/selfServe";
import { unsubscribe, unsubscribeByAddress, UNSUB_PER_IP_PER_HOUR } from "@/lib/unsubscribe";

// A name that does not resolve is refused, so the invented *.example sites
// used here resolve to a public documentation address; nothing is requested.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host.endsWith(".example")) return [{ address: "93.184.216.34", family: 4 }];
    throw new Error("ENOTFOUND " + host);
  },
}));
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

  it("refuses a website whose name does not resolve", async () => {
    const r = await submitSelfServe({ ...base, website: "no-such-site.invalid", email: "a@no-such-site.invalid" });
    expect(r.ok).toBe(false);
    expect((await db()`select count(*)::int as n from self_serve_requests`)[0].n).toBe(0);
  });

  it("leaves a clinic that is already in the pipeline untouched, with the usual reply", async () => {
    const ok = await submitSelfServe({ ...base, website: "other.example", email: "a@other.example" });
    for (const status of ["contact_found", "audited", "queued", "contacted", "replied", "customer", "held", "suppressed", "do_not_contact"]) {
      await resetData();
      const id = await makeClinic({ website: "https://maplegrove.example/", domain: "maplegrove.example", status, source: "places", status_reason: "as it was" });
      const r = await submitSelfServe(base);
      expect(r).toEqual(ok);
      const [c] = await db()`select source, status::text, status_reason from clinics where id=${id}`;
      expect(c).toEqual({ source: "places", status, status_reason: "as it was" });
      expect((await db()`select count(*)::int as n from jobs`)[0].n).toBe(0);
      expect((await db()`select count(*)::int as n from self_serve_requests`)[0].n).toBe(0);
    }
  });

  it("takes over a known clinic only when we are not dealing with it", async () => {
    const id = await makeClinic({ website: "https://maplegrove.example/", domain: "maplegrove.example", status: "parked", source: "places" });
    expect((await submitSelfServe(base)).ok).toBe(true);
    const rows = await db()`select id, source, status::text from clinics`;
    expect(rows).toEqual([{ id, source: "self_serve", status: "discovered" }]);
    expect((await db()`select kind from jobs`)[0].kind).toBe("find_contact");
  });

  it("accepts only a city we know or a listed Ontario municipality", async () => {
    const before = (await db()`select count(*)::int as n from cities`)[0].n;
    const bad = await submitSelfServe({ ...base, city: "Atlantis" });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/Ontario/);
    expect((await submitSelfServe({ ...base, city: "Springfield Heights" })).ok).toBe(false);
    expect((await db()`select count(*)::int as n from cities`)[0].n).toBe(before);
    expect((await db()`select count(*)::int as n from self_serve_requests`)[0].n).toBe(0);

    // an existing city in any case: no new row
    expect((await submitSelfServe({ ...base, city: "  bARRIE " })).ok).toBe(true);
    expect((await db()`select count(*)::int as n from cities`)[0].n).toBe(before);
    // a listed municipality typed loosely
    expect((await submitSelfServe({ ...base, ip: "203.0.113.6", website: "soo.example", email: "a@soo.example", city: "sault ste marie" })).ok).toBe(true);
    const [c] = await db()`select ci.name from clinics c join cities ci on ci.id=c.city_id where c.domain='soo.example'`;
    expect(c.name).toBe("Sault Ste. Marie");
  });

  it("holds requests beyond the global daily cap for the owner and runs nothing", async () => {
    const sql = db();
    await sql`update app_settings set self_serve_daily_cap=2 where id`;
    try {
      for (let i = 0; i < 3; i++) {
        const r = await submitSelfServe({ ...base, ip: `198.51.100.${i}`, website: `cap${i}.example`, email: `a@cap${i}.example` });
        expect(r.ok).toBe(true);
      }
      const reqs = await sql`select website, status, reason, clinic_id from self_serve_requests order by created_at`;
      expect(reqs.map((r) => r.status)).toEqual(["received", "received", "held"]);
      expect(reqs[2]).toMatchObject({ website: "https://cap2.example/", clinic_id: null, reason: "daily self-serve limit reached" });
      expect((await sql`select count(*)::int as n from jobs`)[0].n).toBe(2);
      expect((await sql`select count(*)::int as n from clinics`)[0].n).toBe(2);
      expect((await sql`select count(*)::int as n from owner_tasks where status='open'`)[0].n).toBe(1);

      // the owner can run a held request later
      await sql`update app_settings set self_serve_daily_cap=20 where id`;
      const [held] = await sql<{ id: string }[]>`select id from self_serve_requests where status='held'`;
      expect(await runHeldSelfServe(held.id)).toEqual({ ok: true });
      expect((await sql`select count(*)::int as n from jobs`)[0].n).toBe(3);
      expect((await sql`select status from self_serve_requests where id=${held.id}`)[0].status).toBe("received");
    } finally {
      await sql`update app_settings set self_serve_daily_cap=20 where id`;
    }
  });

  it("the per-visitor limit holds when requests arrive at the same moment", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => submitSelfServe({ ...base, website: `race${i}.example`, email: `a@race${i}.example` })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect((await db()`select count(*)::int as n from self_serve_requests`)[0].n).toBe(3);
    expect((await db()`select count(*)::int as n from jobs`)[0].n).toBe(3);
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

  it("never closes a paying customer's clinic", async () => {
    const clinic = await makeClinic({ status: "customer" });
    await db()`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary) values (${clinic}, 'info@testdental.example', 'https://testdental.example/', true, true)`;
    await unsubscribe("info@testdental.example", "unsubscribe_link");
    expect((await isSuppressed("info@testdental.example")).suppressed).toBe(true);
    expect((await db()`select status::text from clinics where id=${clinic}`)[0].status).toBe("customer");
  });
});

describe("unsubscribe by typed address", () => {
  beforeEach(resetData);
  const ip = "203.0.113.50";

  it("ignores an address we never wrote to: nothing is suppressed and no clinic is closed", async () => {
    const clinic = await makeClinic({ status: "queued" });
    await db()`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary) values (${clinic}, 'info@testdental.example', 'https://testdental.example/', true, true)`;
    const r = await unsubscribeByAddress("someone@elsewhere.example", ip);
    expect(r).toEqual({ acted: false, reason: "unknown_address" });
    expect((await db()`select count(*)::int as n from suppressions`)[0].n).toBe(0);
    expect((await db()`select status::text from clinics where id=${clinic}`)[0].status).toBe("queued");
  });

  it("works at once for a known contact, a recipient of our mail, or a self-serve requester", async () => {
    const clinic = await makeClinic({ status: "queued" });
    await db()`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary) values (${clinic}, 'info@testdental.example', 'https://testdental.example/', true, true)`;
    const pending = await makeMessage({ clinic_id: clinic, to_email: "Front.Desk@testdental.example" });
    await db()`insert into self_serve_requests (website, email, status) values ('https://x.example/', 'asker@x.example', 'sent')`;

    expect((await unsubscribeByAddress(" INFO@testdental.example ", ip)).acted).toBe(true);
    expect((await isSuppressed("info@testdental.example")).suppressed).toBe(true);
    expect((await db()`select status::text from clinics where id=${clinic}`)[0].status).toBe("suppressed");

    expect((await unsubscribeByAddress("front.desk@testdental.example", ip)).acted).toBe(true);
    expect((await db()`select status::text from messages where id=${pending}`)[0].status).toBe("cancelled");
    expect((await unsubscribeByAddress("asker@x.example", ip)).acted).toBe(true);
    expect((await isSuppressed("asker@x.example")).suppressed).toBe(true);
  });

  it("limits attempts per visitor, so the form cannot be used to close clinics in bulk", async () => {
    const sql = db();
    const clinics: string[] = [];
    for (let i = 0; i < UNSUB_PER_IP_PER_HOUR + 2; i++) {
      const id = await makeClinic({ status: "queued", domain: `c${i}.example`, website: `https://c${i}.example/` });
      await sql`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary) values (${id}, ${`info@c${i}.example`}, 'x', true, true)`;
      clinics.push(id);
    }
    const out = [];
    for (let i = 0; i < clinics.length; i++) out.push(await unsubscribeByAddress(`info@c${i}.example`, ip));
    expect(out.filter((o) => o.acted)).toHaveLength(UNSUB_PER_IP_PER_HOUR);
    expect(out.at(-1)).toEqual({ acted: false, reason: "rate_limited" });
    expect((await sql`select count(*)::int as n from clinics where status='suppressed'`)[0].n).toBe(UNSUB_PER_IP_PER_HOUR);
    // another visitor is not affected
    expect((await unsubscribeByAddress(`info@c${clinics.length - 1}.example`, "203.0.113.51")).acted).toBe(true);
    // and parallel posts cannot slip past the count
    await sql`truncate unsubscribe_attempts`;
    const burst = await Promise.all(Array.from({ length: 12 }, () => unsubscribeByAddress("nobody@nowhere.example", "203.0.113.52")));
    expect(burst.filter((b) => b.reason === "rate_limited")).toHaveLength(12 - UNSUB_PER_IP_PER_HOUR);
  });
});
