import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/db";
import { resetEnvForTests } from "@/lib/env";
import { setMailProvider, type MailEvent, type MailProvider, type OutboundMail } from "@/lib/adapters/mail";
import { sendMessage, queueDueFollowUps, identificationProblems } from "@/lib/sending/send";
import { queueMessage } from "@/lib/sending/outbox";
import { handleMailEvent } from "@/lib/sending/events";
import { checkDnsRecords, checkDns } from "@/lib/sending/dns";
import { nextWindowStart, startOfNextLocalDay } from "@/lib/sending/rules";
import { ingestInbound, classifyInbound, stripQuoted, isAutoReply, replyFromOwner } from "@/lib/replies/ingest";
import { isSuppressed } from "@/lib/sending/suppression";
import * as approval from "@/lib/sending/approval";
import { DeferJob, enqueue, runJobs } from "@/lib/jobs/queue";
import { runWorkerBudget } from "@/lib/jobs/worker";
import { handlers } from "@/lib/jobs/handlers";
import { getSettings } from "@/lib/settings";
import { localDate, torontoToUtc } from "@/lib/time";
import { unsubscribeUrl } from "@/lib/tokens";
import { makeClinic, makeMessage, resetData } from "./helpers";

const tue10 = torontoToUtc("2026-11-10", "10:00");
const actor = { userId: "00000000-0000-0000-0000-000000000001", email: "owner@intheanswer.test" };
const OWNER = { OWNER_NAME: "Sam Owner", OWNER_BUSINESS_NAME: "In The Answer Inc.", OWNER_MAILING_ADDRESS: "1 Main St, Barrie ON L4M 1A1", OWNER_PHONE: "705-555-0100", MONTHLY_MIN_TERM_MONTHS: "3" };

const sent: OutboundMail[] = [];
let failNext = false;
const fake: MailProvider = {
  async send(m) {
    if (failNext) {
      failNext = false;
      throw new Error("provider down");
    }
    sent.push(m);
    return { id: `re_${sent.length}` };
  },
  async getInbound() {
    throw new Error("not used");
  },
  async domainState() {
    return null;
  },
  verifyWebhook() {
    throw new Error("not used");
  },
};

function body(to: string, extra = "Hello,") {
  return [extra, "", "Sam Owner", "In The Answer Inc.", "1 Main St, Barrie ON L4M 1A1 · 705-555-0100", "", "--", `Stop: ${unsubscribeUrl(to)}`].join("\n");
}

async function goLive() {
  Object.assign(process.env, OWNER, { DRY_RUN: "0" });
  resetEnvForTests();
  await db()`update app_settings set dry_run=false, live_enabled=true, dns_verified=true where id`;
}

async function status(id: string) {
  const [m] = await db()<{ status: string; dry_run: boolean; provider_message_id: string | null; last_error: string | null; review_reason: string | null }[]>`
    select status::text, dry_run, provider_message_id, last_error, review_reason from messages where id=${id}`;
  return m;
}

function event(type: string, emailId: string, to: string, extra: Partial<MailEvent> = {}): MailEvent {
  return { type, createdAt: new Date(), emailId, to: [to], from: null, raw: { type }, ...extra };
}

beforeEach(async () => {
  await resetData();
  sent.length = 0;
  failNext = false;
  setMailProvider(fake);
  Object.assign(process.env, OWNER, { DRY_RUN: "1" });
  resetEnvForTests();
});
afterAll(async () => {
  setMailProvider(null);
  await closeDb();
});

describe("send job", () => {
  it("in a dry run marks the message sent, writes the audit log and sends nothing", async () => {
    const clinic = await makeClinic({ status: "queued" });
    const id = await makeMessage({ clinic_id: clinic, status: "approved", body_text: body("info@testdental.example") });
    const r = await sendMessage(id, undefined, tue10);
    expect(r.outcome).toBe("dry_run");
    expect(sent).toHaveLength(0);
    expect(await status(id)).toMatchObject({ status: "sent", dry_run: true, provider_message_id: null });
    const [log] = await db()`select dry_run, recipient from send_audit_log where message_id=${id}`;
    expect(log).toMatchObject({ dry_run: true, recipient: "info@testdental.example" });
    const [c] = await db()`select contact_count, status::text from clinics where id=${clinic}`;
    expect(c).toMatchObject({ contact_count: 0, status: "queued" }); // a dry run uses up no contact
  });

  it("live: sends once with the unsubscribe headers and counts the contact", async () => {
    await goLive();
    const clinic = await makeClinic({ status: "queued" });
    const id = await makeMessage({ clinic_id: clinic, status: "approved", dry_run: false, body_text: body("info@testdental.example") });
    expect((await sendMessage(id, undefined, tue10)).outcome).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].headers?.["List-Unsubscribe"]).toMatch(/\/api\/unsubscribe\//);
    expect(sent[0].headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent[0].idempotencyKey).toBe(`msg-${id}`);
    expect(await status(id)).toMatchObject({ status: "sent", dry_run: false, provider_message_id: "re_1" });
    const [c] = await db()`select contact_count, status::text from clinics where id=${clinic}`;
    expect(c).toMatchObject({ contact_count: 1, status: "contacted" });
    // running the job again does nothing
    expect((await sendMessage(id, undefined, tue10)).outcome).toBe("skipped");
    expect(sent).toHaveLength(1);
  });

  it("a message created in a dry run stays a dry run after going live", async () => {
    const id = await makeMessage({ status: "approved", dry_run: true, body_text: body("info@testdental.example") });
    await goLive();
    expect((await sendMessage(id, undefined, tue10)).outcome).toBe("dry_run");
    expect(sent).toHaveLength(0);
  });

  it("defers on the DNS gate and schedules a re-check; blocks a suppressed address", async () => {
    await goLive();
    await db()`update app_settings set dns_verified=false where id`;
    const id = await makeMessage({ status: "approved", dry_run: false, body_text: body("info@testdental.example") });
    await expect(sendMessage(id, undefined, tue10)).rejects.toBeInstanceOf(DeferJob);
    expect((await status(id)).status).toBe("scheduled");
    expect((await db()`select 1 from jobs where kind='check_dns'`).length).toBe(1);

    await db()`update app_settings set dns_verified=true where id`;
    await db()`insert into suppressions (kind, value, reason, source) values ('address', 'info@testdental.example', 'unsubscribed', 'reply')`;
    expect((await sendMessage(id, undefined, tue10)).outcome).toBe("blocked");
    expect(sent).toHaveLength(0);
  });

  it("spaces cold sends: the second one the same minute is deferred", async () => {
    await goLive();
    const a = await makeMessage({ status: "approved", dry_run: false, to_email: "a@a.example", body_text: body("a@a.example") });
    const b = await makeMessage({ status: "approved", dry_run: false, to_email: "b@b.example", body_text: body("b@b.example") });
    expect((await sendMessage(a, undefined, tue10)).outcome).toBe("sent");
    await expect(sendMessage(b, undefined, tue10)).rejects.toBeInstanceOf(DeferJob);
    expect(sent).toHaveLength(1);
  });

  it("holds a message that lost the sender's address or the unsubscribe link", async () => {
    await goLive();
    const id = await makeMessage({ status: "approved", dry_run: false, body_text: "Hello, just checking in." });
    const r = await sendMessage(id, undefined, tue10);
    expect(r.outcome).toBe("held");
    expect((await status(id)).review_reason).toMatch(/mailing address is missing/);
    expect(identificationProblems("first_email", "x")).toHaveLength(3);
    expect(identificationProblems("owner_alert", "x")).toHaveLength(0);
  });

  it("a provider failure leaves the message approved for the retry", async () => {
    await goLive();
    const id = await makeMessage({ status: "approved", dry_run: false, body_text: body("info@testdental.example") });
    failNext = true;
    await expect(sendMessage(id, undefined, tue10)).rejects.toThrow("provider down");
    expect(await status(id)).toMatchObject({ status: "approved", last_error: "provider down" });
    expect((await sendMessage(id, undefined, tue10)).outcome).toBe("sent");
  });

  it("an edit that removes the mailing address is refused", async () => {
    Object.assign(process.env, OWNER);
    resetEnvForTests();
    const id = await makeMessage({ body_text: body("info@testdental.example") });
    await expect(approval.editAndApprove(id, actor, "Subject", `Hello\n\n--\n${unsubscribeUrl("info@testdental.example")}`)).rejects.toThrow(/mailing address/);
  });

  it("the day after the cap is reached is the next business day, not the one after", () => {
    const s = { send_window_start: "09:30", send_window_end: "16:30" };
    expect(localDate(nextWindowStart(startOfNextLocalDay(torontoToUtc("2026-11-09", "10:00")), s))).toBe("2026-11-10");
    expect(localDate(nextWindowStart(startOfNextLocalDay(torontoToUtc("2026-11-13", "10:00")), s))).toBe("2026-11-16"); // Friday -> Monday
  });
});

describe("follow-up", () => {
  it("is queued once, only after the waiting period and only without a reply", async () => {
    await goLive();
    const clinic = await makeClinic({ status: "contacted", contact_count: 1 });
    const [rep] = await db()<{ id: string }[]>`insert into reports (clinic_id, kind, token, data, html) values (${clinic}, 'teaser', 'tok-fu', '{}', '') returning id`;
    await makeMessage({ clinic_id: clinic, status: "sent", dry_run: false, sent_at: torontoToUtc("2026-11-02", "10:00"), report_id: rep.id, contact_source_url: "https://testdental.example/contact" });
    expect(await queueDueFollowUps(torontoToUtc("2026-11-04", "10:00"))).toBe(0); // too soon
    expect(await queueDueFollowUps(tue10)).toBe(1);
    expect(await queueDueFollowUps(tue10)).toBe(0); // once
    const [f] = await db()<{ status: string; body_text: string }[]>`select status::text, body_text from messages where type='follow_up'`;
    expect(f.status).toBe("pending_review");
    expect(identificationProblems("follow_up", f.body_text)).toEqual([]);

    const other = await makeClinic({ name: "Replied", status: "contacted", contact_count: 1, replied: true });
    await makeMessage({ clinic_id: other, status: "sent", dry_run: false, sent_at: torontoToUtc("2026-11-02", "10:00"), report_id: rep.id, to_email: "x@replied.example" });
    expect(await queueDueFollowUps(tue10)).toBe(0);
  });
});

describe("provider events", () => {
  it("a hard bounce suppresses the address; a repeat of the event is ignored", async () => {
    const clinic = await makeClinic({ status: "contacted" });
    const id = await makeMessage({ clinic_id: clinic, status: "sent", dry_run: false, sent_at: new Date(), provider_message_id: "re_b1" });
    const ev = event("email.bounced", "re_b1", "info@testdental.example", { bounceType: "Permanent", detail: "mailbox does not exist" });
    expect((await handleMailEvent(ev, "evt_1")).handled).toBe(true);
    expect((await handleMailEvent(ev, "evt_1")).note).toBe("duplicate");
    expect((await isSuppressed("info@testdental.example")).suppressed).toBe(true);
    const [m] = await db()`select bounced_at from messages where id=${id}`;
    expect(m.bounced_at).not.toBeNull();
    expect((await db()`select 1 from message_events where message_id=${id}`).length).toBe(1);
    const [c] = await db()`select status::text from clinics where id=${clinic}`;
    expect(c.status).toBe("no_contact");
  });

  it("a complaint pauses all sending and alerts the owner", async () => {
    await makeMessage({ status: "sent", dry_run: false, sent_at: new Date(), provider_message_id: "re_c1" });
    await handleMailEvent(event("email.complained", "re_c1", "info@testdental.example"), "evt_2");
    expect((await getSettings()).auto_paused).toBe(true);
    expect((await isSuppressed("info@testdental.example")).suppressed).toBe(true);
    const [alert] = await db()`select subject from messages where type='owner_alert'`;
    expect(alert.subject).toMatch(/paused/);
  });

  it("inbound mail is queued for reading", async () => {
    await handleMailEvent(event("email.received", "in_1", "hello@mail.intheanswer.ca"), "evt_3");
    expect((await db()`select 1 from jobs where kind='ingest_reply' and idempotency_key='inbound:in_1'`).length).toBe(1);
  });
});

describe("replies", () => {
  const inbound = (over: Record<string, unknown> = {}) => ({
    id: "in_1", from: "Front Desk <info@testdental.example>", to: ["hello@mail.intheanswer.ca"], subject: "Re: your report",
    text: "How much does it cost?\n\nOn Tue, Nov 10, 2026 at 10:00 AM Sam wrote:\n> the original", messageId: "<abc@mail>", headers: {}, receivedAt: new Date(), ...over,
  });

  it("strips quoted text and recognises automatic replies", () => {
    expect(stripQuoted("Thanks!\n\nOn Tue, Nov 10, 2026 at 10:00 AM Sam wrote:\n> hi")).toBe("Thanks!");
    expect(isAutoReply({ subject: "Automatic reply: your report", headers: {} })).toBe(true);
    expect(isAutoReply({ subject: "Re: your report", headers: { "auto-submitted": "auto-replied" } })).toBe(true);
    expect(isAutoReply({ subject: "Re: your report", headers: {} })).toBe(false);
  });

  it("a reply stops the cold sequence, is forwarded to the owner, and a known question gets a drafted approved answer", async () => {
    const clinic = await makeClinic({ status: "contacted", contact_count: 1 });
    const first = await makeMessage({ clinic_id: clinic, status: "sent", sent_at: new Date() });
    const follow = await makeMessage({ clinic_id: clinic, type: "follow_up", status: "pending_review", to_email: "info@testdental.example" });
    const r = await ingestInbound(inbound());
    expect(r.created).toBe(true);
    expect((await ingestInbound(inbound())).created).toBe(false); // webhook retry
    const [c] = await db()`select replied, status::text from clinics where id=${clinic}`;
    expect(c).toMatchObject({ replied: true, status: "replied" });
    expect((await status(follow)).status).toBe("cancelled");
    const [m] = await db()`select replied_at from messages where id=${first}`;
    expect(m.replied_at).not.toBeNull();
    expect((await db()`select 1 from messages where type='owner_alert'`).length).toBe(1);

    const res = await classifyInbound(r.id, async () => ({ data: { classification: "question", reason: "asks the price", answer_key: "price" }, costUsd: 0, usage: {} }));
    expect(res).toMatchObject({ classification: "question", drafted: true, escalated: false });
    const [d] = await db()<{ status: string; body_text: string; inbound_id: string }[]>`select status::text, body_text, inbound_id from messages where type='question_answer'`;
    expect(d.status).toBe("pending_review");
    expect(d.body_text).toMatch(/200 CAD/);
    expect(d.inbound_id).toBe(r.id);
  });

  it("an unsubscribe request is applied at once without a model", async () => {
    const clinic = await makeClinic({ status: "contacted" });
    await makeMessage({ clinic_id: clinic, status: "sent", sent_at: new Date() });
    await db()`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary) values (${clinic}, 'info@testdental.example', 'https://testdental.example/', true, true)`;
    const r = await ingestInbound(inbound({ text: "Please remove us from your list." }));
    expect(r.classification).toBe("unsubscribe");
    expect((await isSuppressed("info@testdental.example")).suppressed).toBe(true);
    expect((await db()`select 1 from jobs where kind='classify_reply'`).length).toBe(0);
  });

  it("an automatic reply does not count as a reply", async () => {
    const clinic = await makeClinic({ status: "contacted" });
    await makeMessage({ clinic_id: clinic, status: "sent", sent_at: new Date() });
    await ingestInbound(inbound({ subject: "Out of office" }));
    const [c] = await db()`select replied from clinics where id=${clinic}`;
    expect(c.replied).toBe(false);
  });

  it("anything unclear is escalated with no draft; the owner's own reply goes straight to sending", async () => {
    Object.assign(process.env, OWNER);
    resetEnvForTests();
    const r = await ingestInbound(inbound({ text: "I am contacting my lawyer about this." }));
    const res = await classifyInbound(r.id, async () => ({ data: { classification: "other", reason: "legal", answer_key: null }, costUsd: 0, usage: {} }));
    expect(res).toMatchObject({ drafted: false, escalated: true });
    expect((await db()`select 1 from owner_tasks where kind='escalation' and status='open'`).length).toBe(1);
    await replyFromOwner(r.id, "I am sorry for the trouble. I have removed your address.");
    const [m] = await db()<{ status: string; body_text: string }[]>`select status::text, body_text from messages where type='question_answer'`;
    expect(m.status).toBe("approved");
    expect(m.body_text).toMatch(/Sam Owner/);
    expect((await db()`select 1 from owner_tasks where status='open'`).length).toBe(0);
  });
});

describe("DNS gate", () => {
  const records: Record<string, string[]> = {
    "send.mail.intheanswer.ca": ["v=spf1 include:amazonses.com ~all"],
    "resend._domainkey.mail.intheanswer.ca": ["p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC"],
    "_dmarc.intheanswer.ca": ["v=DMARC1; p=none;"],
  };
  const txt = async (name: string) => records[name] ?? [];

  it("passes with SPF, DKIM and an organisation-level DMARC record, and fails without DKIM", async () => {
    const ok = await checkDnsRecords("mail.intheanswer.ca", txt);
    expect([ok.spf.ok, ok.dkim.ok, ok.dmarc.ok]).toEqual([true, true, true]);
    const bad = await checkDnsRecords("mail.intheanswer.ca", async (n) => (n.includes("_domainkey") ? [] : txt(n)));
    expect(bad.dkim.ok).toBe(false);
  });

  it("records the result in settings", async () => {
    expect((await checkDns(txt)).ok).toBe(true);
    expect((await getSettings()).dns_verified).toBe(true);
    expect((await checkDns(async () => [])).ok).toBe(false);
    expect((await getSettings()).dns_verified).toBe(false);
  });
});

describe("queue and owner actions", () => {
  it("regenerate cancels the draft and starts a fresh audit", async () => {
    const clinic = await makeClinic({ status: "queued" });
    const id = await makeMessage({ clinic_id: clinic });
    await approval.regenerate(id, actor);
    expect((await status(id)).status).toBe("cancelled");
    expect((await db()`select 1 from jobs where kind='audit_clinic'`).length).toBe(1);
    const [c] = await db()`select status::text from clinics where id=${clinic}`;
    expect(c.status).toBe("contact_found");
  });

  it("a sent message cannot be skipped", async () => {
    const id = await makeMessage({ status: "sent", sent_at: new Date() });
    await expect(approval.skip(id, actor)).rejects.toThrow(/cannot skip/);
    expect((await status(id)).status).toBe("sent");
  });

  it("a job reaped while it waited behind a slow one is not run twice", async () => {
    await enqueue("t_slow", "slow", {}, { priority: 1 });
    await enqueue("t_fast", "fast", {}, { priority: 2 });
    let fastRuns = 0;
    const res = await runJobs(
      {
        // while the slow job runs, the reaper takes the waiting job back and another worker finishes it
        t_slow: async () => {
          await db()`update jobs set status='done', locked_by='other-worker' where idempotency_key='fast'`;
        },
        t_fast: async () => {
          fastRuns++;
        },
      },
      { limit: 2, kinds: ["t_slow", "t_fast"] },
    );
    expect(fastRuns).toBe(0);
    expect(res.done).toBe(1);
  });

  it("a deferred job does not stop the rest of the run", async () => {
    handlers.t_wait = async () => {
      throw new DeferJob(600, "waiting");
    };
    let ran = 0;
    handlers.t_work = async () => {
      ran++;
    };
    try {
      await enqueue("t_wait", "w1", {}, { priority: 1 });
      await enqueue("t_work", "k1", {}, { priority: 2 });
      await enqueue("t_work", "k2", {}, { priority: 2 });
      // run only the two test kinds: other handlers in the registry are not part of this test
      await db()`update jobs set run_after = now() + interval '1 day' where kind not in ('t_wait', 't_work')`;
      const r = await runWorkerBudget(60_000);
      expect(ran).toBe(2);
      expect(r.deferred).toBe(1);
    } finally {
      delete handlers.t_wait;
      delete handlers.t_work;
    }
  });

  it("the outbox is idempotent and owner mail is never held for review", async () => {
    const a = await queueMessage({ type: "owner_alert", toEmail: "owner@intheanswer.test", subject: "s", bodyText: "b", idempotencyKey: "k1" });
    const b = await queueMessage({ type: "owner_alert", toEmail: "owner@intheanswer.test", subject: "s", bodyText: "b", idempotencyKey: "k1" });
    expect(a).toMatchObject({ created: true, status: "approved" });
    expect(b).toMatchObject({ created: false, id: a.id });
    const c = await queueMessage({ type: "monthly_report", toEmail: "info@testdental.example", subject: "s", bodyText: "b", idempotencyKey: "k2" });
    expect(c.status).toBe("pending_review");
  });
});
