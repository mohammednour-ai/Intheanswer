import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, closeDb } from "@/lib/db";
import { assertPublicUrl, BlockedUrlError, fetchPage, probeUrl, safeFetch } from "@/lib/adapters/http";
import { resetEnvForTests, appSecret, DEV_APP_SECRET } from "@/lib/env";
import type { Crawl, CrawledPage } from "@/lib/sitetest/crawl";
import { checkHttps } from "@/lib/sitetest/checks";
import { makeRequestGuard } from "@/lib/sitetest/browser";
import { isAutomatedFetch } from "@/lib/site/viewers";
import { connectLinkProblem, CONNECT_LINK_DAYS } from "@/lib/reviews/gbp";
import { putFile } from "@/lib/storage";
import { parsePage } from "@/lib/site/parse";
import { resetData } from "./helpers";

// Invented hosts. Names are resolved by this table only; nothing leaves the machine.
const DNS: Record<string, string> = {
  "public.example": "93.184.216.34",
  "www.public.example": "93.184.216.34",
  "rebind.example": "10.0.0.7",
  "metadata.example": "169.254.169.254",
};
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (DNS[host]) return [{ address: DNS[host], family: 4 }];
    throw new Error("ENOTFOUND " + host);
  },
}));

afterAll(closeDb);

describe("page cache keeps the address a request ended on", () => {
  beforeEach(resetData);
  const html = "<html><head><title>Clinic</title></head><body><h1>Clinic</h1><a href='/contact'>Contact</a></body></html>";

  it("a cache hit returns the stored redirect target, not the requested URL", async () => {
    await db()`insert into page_cache (url, domain, http_status, content_type, body, final_url)
               values ('http://clinic.example/', 'clinic.example', 200, 'text/html', ${html}, 'https://www.clinic.example/')`;
    const p = await fetchPage("http://clinic.example/");
    expect(p).toMatchObject({ fromCache: true, finalUrl: "https://www.clinic.example/", finalUrlKnown: true });
  });

  it("a row cached without it says the final address is not known", async () => {
    await db()`insert into page_cache (url, domain, http_status, content_type, body) values ('http://clinic.example/', 'clinic.example', 200, 'text/html', ${html})`;
    const p = await fetchPage("http://clinic.example/");
    expect(p).toMatchObject({ fromCache: true, finalUrl: "http://clinic.example/", finalUrlKnown: false });
  });

  const page = (url: string, over: Partial<CrawledPage> = {}): CrawledPage => ({ ...parsePage(url, html), depth: 0, status: 200, finalUrl: url, ...over });
  const crawlOf = (home: CrawledPage): Crawl => ({
    website: home.url, domain: "clinic.example", home, homeRedirectedToHttps: null, pages: [home], statuses: new Map(), notVisited: [], robotsTxt: "", robotsStatus: 404, cap: 40,
  });

  it("HTTPS check: an unknown final address is could-not-test, never a finding", () => {
    // old cache row for an http:// start address: we cannot know whether it redirects
    const unknown = checkHttps(crawlOf(page("http://clinic.example/", { finalUrlKnown: false })), null);
    expect(unknown.result).toBe("could_not_test");
    expect(unknown.findingText).toBeUndefined();
    // the redirect was followed and recorded: pass
    expect(checkHttps(crawlOf(page("http://clinic.example/", { finalUrl: "https://clinic.example/", finalUrlKnown: true })), { finalUrl: "https://clinic.example/", status: 200 }).result).toBe("pass");
    // a site really served over http, with the final address known, is still reported
    expect(checkHttps(crawlOf(page("http://clinic.example/", { finalUrlKnown: true })), null).result).toBe("needs_work");
    // no usable http probe (unknown final address there too): no "does not redirect" finding
    expect(checkHttps(crawlOf(page("https://clinic.example/", { finalUrlKnown: true })), null).result).toBe("pass");
  });
});

describe("only public addresses are requested, on every redirect hop", () => {
  const calls: string[] = [];
  const route = (map: Record<string, { status: number; location?: string }>) =>
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      expect(init?.redirect).toBe("manual");
      const r = map[String(url)] ?? { status: 404 };
      return new Response(r.status >= 300 && r.status < 400 ? null : "ok", { status: r.status, headers: r.location ? { location: r.location } : {} });
    });
  beforeEach(() => void (calls.length = 0));
  afterEach(() => vi.unstubAllGlobals());

  it("refuses private, loopback, link-local and unresolvable hosts", async () => {
    for (const u of ["http://127.0.0.1/", "http://10.1.2.3/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://localhost:3000/", "ftp://public.example/", "http://intranet/"]) {
      await expect(assertPublicUrl(u)).rejects.toBeInstanceOf(BlockedUrlError);
    }
    await expect(assertPublicUrl("https://rebind.example/")).rejects.toThrow(/private network/);
    // a name that does not resolve is not known to be public: refused, not waved through
    await expect(assertPublicUrl("https://does-not-resolve.example/")).rejects.toThrow(/could not be resolved/);
    await expect(assertPublicUrl("https://public.example/x")).resolves.toBeUndefined();
    await expect(assertPublicUrl("https://93.184.216.34/")).resolves.toBeUndefined();
  });

  it("follows public redirects and reports where it ended", async () => {
    route({
      "http://public.example/": { status: 301, location: "https://public.example/" },
      "https://public.example/": { status: 302, location: "/home" },
      "https://public.example/home": { status: 200 },
    });
    const { res, finalUrl } = await safeFetch("http://public.example/");
    expect(res.status).toBe(200);
    expect(finalUrl).toBe("https://public.example/home");
    expect(calls).toHaveLength(3);
  });

  it("a redirect to a private address is refused before it is requested", async () => {
    route({
      "https://public.example/a": { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
      "https://public.example/b": { status: 307, location: "https://rebind.example/admin" },
      "https://public.example/c": { status: 302, location: "http://metadata.example/" },
    });
    for (const p of ["a", "b", "c"]) await expect(safeFetch(`https://public.example/${p}`)).rejects.toBeInstanceOf(BlockedUrlError);
    // only the three public first hops were ever requested
    expect(calls).toEqual(["GET https://public.example/a", "GET https://public.example/b", "GET https://public.example/c"]);
  });

  it("stops after five redirects", async () => {
    const map: Record<string, { status: number; location?: string }> = {};
    for (let i = 0; i < 10; i++) map[`https://public.example/${i}`] = { status: 302, location: `/${i + 1}` };
    route(map);
    await expect(safeFetch("https://public.example/0")).rejects.toThrow(/too many redirects/);
    expect(calls).toHaveLength(6);
  });

  it("the link probe has the same check: a redirect to a private host is 'could not test'", async () => {
    const prev = process.env.EXTERNAL_MODE;
    process.env.EXTERNAL_MODE = "live";
    resetEnvForTests();
    try {
      route({
        "https://public.example/robots.txt": { status: 404 },
        "https://public.example/img.png": { status: 302, location: "http://10.0.0.5/secret.png" },
      });
      const r = await probeUrl("https://public.example/img.png");
      expect(r.status).toBe(0);
      expect(r.reason).toMatch(/not public/);
      expect(calls.some((c) => c.includes("10.0.0.5"))).toBe(false);
    } finally {
      process.env.EXTERNAL_MODE = prev;
      resetEnvForTests();
    }
  });

  it("the headless browser guard aborts requests to private hosts and lets public ones through", async () => {
    const blocked = makeRequestGuard();
    expect(await blocked("https://public.example/app.js")).toBe(false);
    expect(await blocked("data:image/png;base64,AAAA")).toBe(false);
    expect(await blocked("http://127.0.0.1:9222/json")).toBe(true);
    expect(await blocked("http://169.254.169.254/latest/meta-data/")).toBe(true);
    expect(await blocked("https://rebind.example/pixel.gif")).toBe(true);
    expect(await blocked("https://does-not-resolve.example/x.css")).toBe(true);
    expect(await blocked("file:///etc/passwd")).toBe(true);
    expect(await blocked("ws://localhost:1234/")).toBe(true);
  });
});

describe("smaller guards", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it("APP_SECRET: the development default or a short secret is refused in production, but not while building", () => {
    expect(appSecret()).toBe("test-secret"); // tests: NODE_ENV=test
    const set = (env: Record<string, string>) => {
      vi.unstubAllEnvs();
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      resetEnvForTests();
    };
    set({ NODE_ENV: "production", APP_SECRET: DEV_APP_SECRET });
    expect(() => appSecret()).toThrow(/APP_SECRET/);
    set({ NODE_ENV: "production", APP_SECRET: "short-secret" });
    expect(() => appSecret()).toThrow(/at least 32/);
    set({ NODE_ENV: "production", APP_SECRET: "x".repeat(32) });
    expect(appSecret()).toBe("x".repeat(32));
    // `next build` runs with NODE_ENV=production and no secrets
    set({ NODE_ENV: "production", APP_SECRET: DEV_APP_SECRET, NEXT_PHASE: "phase-production-build" });
    expect(appSecret()).toBe(DEV_APP_SECRET);
    set({ NODE_ENV: "development", APP_SECRET: DEV_APP_SECRET });
    expect(appSecret()).toBe(DEV_APP_SECRET);
  });

  it("report files are not written to local disk in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    resetEnvForTests();
    await expect(putFile("reports/x.pdf", Buffer.from("x"), "application/pdf")).rejects.toThrow(/storage is not configured/);
  });

  it("report views: link scanners, crawlers and prefetches are not people", () => {
    const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
    expect(isAutomatedFetch(chrome)).toBe(false);
    expect(isAutomatedFetch(iphone)).toBe(false);
    for (const ua of [
      "", "curl/8.4.0", "python-requests/2.31.0", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36",
      "Mozilla/5.0 (compatible; Barracuda Sentinel; +https://www.barracuda.com)", "WhatsApp/2.23.20.0 A",
    ]) expect(isAutomatedFetch(ua), ua).toBe(true);
    expect(isAutomatedFetch(chrome, new Headers({ "sec-purpose": "prefetch;prerender" }))).toBe(true);
    expect(isAutomatedFetch(chrome, new Headers({ accept: "text/html" }))).toBe(false);
  });

  it("Business Profile connect links: refused once connected, and after 14 days", () => {
    expect(connectLinkProblem(undefined)).toMatch(/unknown/);
    expect(connectLinkProblem({ status: "connected", link_age_days: 1 })).toMatch(/already connected/);
    expect(connectLinkProblem({ status: "pending", link_age_days: CONNECT_LINK_DAYS + 0.1 })).toMatch(/expired/);
    expect(connectLinkProblem({ status: "pending", link_age_days: 13.9 })).toBeNull();
    expect(connectLinkProblem({ status: "error", link_age_days: 2 })).toBeNull();
  });
});

describe("schema fixes", () => {
  beforeEach(resetData);

  it("a new connect link restarts the 14 days", async () => {
    const sql = db();
    const [city] = await sql<{ id: number }[]>`select id from cities limit 1`;
    const [sector] = await sql<{ id: number }[]>`select id from sectors limit 1`;
    const [c] = await sql<{ id: string }[]>`insert into clinics (name, city_id, sector_id, source) values ('X', ${city.id}, ${sector.id}, 'seed') returning id`;
    await sql`insert into gbp_connections (clinic_id, connect_token, link_created_at) values (${c.id}, 'tok-one', now() - interval '30 days')`;
    await sql`update gbp_connections set last_error='x' where clinic_id=${c.id}`;
    expect((await sql`select link_created_at < now() - interval '29 days' as old from gbp_connections`)[0].old).toBe(true);
    await sql`insert into gbp_connections (clinic_id, connect_token) values (${c.id}, 'tok-two')
              on conflict (clinic_id) do update set connect_token=excluded.connect_token, status='pending'`;
    expect((await sql`select link_created_at > now() - interval '1 minute' as fresh from gbp_connections`)[0].fresh).toBe(true);
  });

  it("a clinic can be erased: nothing that points at it blocks the delete, and the send log is kept", async () => {
    const sql = db();
    const [city] = await sql<{ id: number }[]>`select id from cities limit 1`;
    const [sector] = await sql<{ id: number }[]>`select id from sectors limit 1`;
    const [c] = await sql<{ id: string }[]>`insert into clinics (name, city_id, sector_id, source) values ('Erase Me Dental', ${city.id}, ${sector.id}, 'seed') returning id`;
    const [rep] = await sql<{ id: string }[]>`insert into reports (clinic_id, kind, token, data, html) values (${c.id}, 'teaser', 'tok_erase_0000000000', '{}', '<p>x</p>') returning id`;
    const [m] = await sql<{ id: string }[]>`
      insert into messages (clinic_id, type, status, to_email, subject, body_text, report_id)
      values (${c.id}, 'first_email', 'sent', 'info@erase.example', 's', 'b', ${rep.id}) returning id`;
    await sql`insert into send_audit_log (message_id, recipient, content_hash, unsubscribe_status, dry_run) values (${m.id}, 'info@erase.example', 'h', 'not_suppressed', true)`;
    await sql`insert into owner_tasks (kind, clinic_id, title, report_id) values ('alert', ${c.id}, 't', ${rep.id})`;
    await sql`insert into self_serve_requests (website, email, clinic_id) values ('https://erase.example/', 'info@erase.example', ${c.id})`;
    await sql`insert into report_views (report_id, ua_hash) values (${rep.id}, 'abc')`;

    await sql`delete from clinics where id=${c.id}`;
    expect((await sql`select count(*)::int as n from reports`)[0].n).toBe(0);
    expect((await sql`select clinic_id, report_id from messages where id=${m.id}`)[0]).toEqual({ clinic_id: null, report_id: null });
    expect((await sql`select clinic_id, report_id from owner_tasks`)[0]).toEqual({ clinic_id: null, report_id: null });
    expect((await sql`select clinic_id from self_serve_requests`)[0].clinic_id).toBeNull();
    // the message itself can go too; the record of the send stays
    await sql`delete from messages where id=${m.id}`;
    expect((await sql`select message_id, recipient from send_audit_log`)[0]).toEqual({ message_id: null, recipient: "info@erase.example" });
  });
});
