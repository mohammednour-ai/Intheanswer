import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { isPrivateHost, assertPublicUrl } from "@/lib/adapters/http";
import { ownSiteName } from "@/lib/pipeline/contact";
import { locationMatchesDomain } from "@/lib/reviews/gbp";
import { expirePending, runWorkerBudget } from "@/lib/jobs/worker";
import { siteCandidates } from "@/lib/reports/teaser";
import { enqueue } from "@/lib/jobs/queue";
import "@/lib/jobs/register";
import { resetData, makeClinic, makeMessage } from "./helpers";

describe("only public addresses are fetched", () => {
  it("blocks loopback, private, link-local and internal names", async () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "db.internal", "printer.local", "intranet"])
      expect(isPrivateHost(h), h).toBe(true);
    for (const h of ["adentaloffice.ca", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateHost(h), h).toBe(false);
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/not public/);
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/http/);
  });
});

describe("names and locations come from the clinic itself", () => {
  it("takes the clinic name from its own page title or main heading", () => {
    expect(ownSiteName("Maple Grove Dental | Barrie Dentist", [])).toBe("Maple Grove Dental");
    expect(ownSiteName("Home - Maple Grove Dental", [])).toBe("Maple Grove Dental");
    expect(ownSiteName("", ["Maple Grove Dental"])).toBe("Maple Grove Dental");
    expect(ownSiteName("", [])).toBeNull();
  });
  it("a Business Profile location must list the clinic's own website", () => {
    expect(locationMatchesDomain("https://www.maplegrove.example/contact", "maplegrove.example")).toBe(true);
    expect(locationMatchesDomain("https://maplegrove.example.evil.com/", "maplegrove.example")).toBe(false);
    expect(locationMatchesDomain(undefined, "maplegrove.example")).toBe(false);
  });
});

describe("queue housekeeping", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  it("pending items expire after their date and the clinic's audit is queued again", async () => {
    const clinic = await makeClinic({ status: "queued" });
    const old = await makeMessage({ clinic_id: clinic, expires_at: new Date(Date.now() - 1000) });
    const fresh = await makeMessage({ clinic_id: clinic, to_email: "b@b.example", expires_at: new Date(Date.now() + 86400e3) });
    expect(await expirePending()).toBe(1);
    const rows = await db()`select id, status::text from messages where id in (${old}, ${fresh})`;
    expect(rows.find((r) => r.id === old)?.status).toBe("expired");
    expect(rows.find((r) => r.id === fresh)?.status).toBe("pending_review");
    const [j] = await db()`select count(*)::int as n from jobs where kind='audit_clinic'`;
    expect(j.n).toBe(1);
    const [l] = await db()`select action from approval_log where message_id=${old}`;
    expect(l.action).toBe("expire");
  });

  it("a send job for a message that no longer exists finishes quietly", async () => {
    await enqueue("send_message", "send:x", { messageId: "00000000-0000-0000-0000-00000000dead" });
    await db()`update jobs set run_after = now() + interval '1 day' where kind <> 'send_message'`;
    const r = await runWorkerBudget(20_000);
    expect(r.done).toBe(1);
  });

  it("a lab-only speed result is never a teaser finding; a PageSpeed one can be", async () => {
    const clinic = await makeClinic();
    const [run] = await db()<{ id: string }[]>`
      insert into site_test_runs (clinic_id, run_label, status, page_cap, pages_crawled, finished_at) values (${clinic}, 't', 'done', 40, 10, now()) returning id`;
    const add = (key: string, source: string) => db()`
      insert into site_test_checks (run_id, check_key, category, result, impact, line, finding_text, metrics)
      values (${run.id}, ${key}, 'speed', 'needs_work', 88, 'l', 'Slow.', ${db().json({ source })})`;
    await add("speed_mobile", "lighthouse_local");
    await add("speed_desktop", "pagespeed");
    const c = (await siteCandidates(clinic)).candidates;
    expect(c.find((x) => x.check_key === "site:speed_mobile")?.finding_text).toBeNull();
    expect(c.find((x) => x.check_key === "site:speed_desktop")?.finding_text).toBe("Slow.");
  });
});
