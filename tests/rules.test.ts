import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { warmupCapForDate, checkSend, nextSlot, evaluateAutoPause } from "@/lib/sending/rules";
import { addSuppression, isSuppressed } from "@/lib/sending/suppression";
import { getSettings } from "@/lib/settings";
import { torontoToUtc, inSendWindow, addBusinessDays, localDate } from "@/lib/time";
import { resetData, makeClinic, makeMessage } from "./helpers";

const base = { warmup_start_date: "2026-11-02", warmup_start_per_day: 10, warmup_step_per_week: 5, warmup_ceiling: 40, daily_cap_override: null };

describe("warm-up cap", () => {
  it("starts at 10, adds 5 each week, stops at 40", () => {
    expect(warmupCapForDate(base, "2026-11-02")).toBe(10);
    expect(warmupCapForDate(base, "2026-11-08")).toBe(10);
    expect(warmupCapForDate(base, "2026-11-09")).toBe(15);
    expect(warmupCapForDate(base, "2026-11-16")).toBe(20);
    expect(warmupCapForDate(base, "2027-03-01")).toBe(40);
  });
  it("is 10 before a start date is set, and an override can only lower it", () => {
    expect(warmupCapForDate({ ...base, warmup_start_date: null }, "2026-11-10")).toBe(10);
    expect(warmupCapForDate({ ...base, daily_cap_override: 3 }, "2027-03-01")).toBe(3);
    expect(warmupCapForDate({ ...base, daily_cap_override: 99 }, "2026-11-02")).toBe(10);
  });
});

describe("Toronto time", () => {
  it("converts wall-clock to UTC across DST", () => {
    expect(torontoToUtc("2026-07-15", "09:30").toISOString()).toBe("2026-07-15T13:30:00.000Z");
    expect(torontoToUtc("2026-12-15", "09:30").toISOString()).toBe("2026-12-15T14:30:00.000Z");
  });
  it("only business hours on weekdays", () => {
    expect(inSendWindow(new Date("2026-11-10T15:00:00Z"), "09:30", "16:30")).toBe(true); // Tue 10:00
    expect(inSendWindow(new Date("2026-11-10T13:00:00Z"), "09:30", "16:30")).toBe(false); // Tue 08:00
    expect(inSendWindow(new Date("2026-11-14T16:00:00Z"), "09:30", "16:30")).toBe(false); // Sat
  });
  it("adds business days", () => {
    const fri = new Date("2026-11-13T15:00:00Z");
    expect(localDate(addBusinessDays(fri, 5))).toBe("2026-11-20");
  });
  it("spreads sends across the window", () => {
    const s = { send_window_start: "09:30", send_window_end: "16:30" };
    const now = torontoToUtc("2026-11-10", "09:30");
    expect(nextSlot(now, s, 10, 0).getTime()).toBe(now.getTime());
    expect(nextSlot(now, s, 10, 5).toISOString()).toBe(torontoToUtc("2026-11-10", "13:00").toISOString());
  });
});

describe("send checks", () => {
  beforeEach(async () => {
    await resetData();
    await db()`update app_settings set dns_verified = true, warmup_start_date='2026-11-02' where id`;
  });
  afterAll(closeDb);
  const tue10 = torontoToUtc("2026-11-10", "10:00");

  it("refuses to send until DNS is verified", async () => {
    await db()`update app_settings set dns_verified=false where id`;
    const clinic = await makeClinic();
    const id = await makeMessage({ clinic_id: clinic });
    const r = await checkSend({ id, type: "first_email", to_email: "info@testdental.example", clinic_id: clinic }, await getSettings(), tue10);
    expect(r.outcome).toBe("defer");
    expect(r.reason).toMatch(/SPF/);
  });

  it("blocks suppressed addresses and domains", async () => {
    const clinic = await makeClinic();
    await addSuppression("domain", "testdental.example", "unsubscribed", "reply");
    expect((await isSuppressed("Someone@TestDental.example")).suppressed).toBe(true);
    const r = await checkSend({ id: "x", type: "first_email", to_email: "info@testdental.example", clinic_id: clinic }, await getSettings(), tue10);
    expect(r.outcome).toBe("block");
  });

  it("never contacts a clinic more than twice, and never after a reply", async () => {
    const clinic = await makeClinic({ contact_count: 2 });
    let r = await checkSend({ id: "x", type: "follow_up", to_email: "a@b.example", clinic_id: clinic }, await getSettings(), tue10);
    expect(r.reason).toMatch(/twice/);
    const c2 = await makeClinic({ name: "Other", replied: true });
    r = await checkSend({ id: "x", type: "follow_up", to_email: "a@c.example", clinic_id: c2 }, await getSettings(), tue10);
    expect(r.reason).toMatch(/replied/);
  });

  it("defers cold mail outside business hours and when the daily cap is reached", async () => {
    const clinic = await makeClinic();
    const sat = torontoToUtc("2026-11-14", "11:00");
    let r = await checkSend({ id: "x", type: "first_email", to_email: "a@b.example", clinic_id: clinic }, await getSettings(), sat);
    expect(r.reason).toBe("outside sending hours");
    expect(localDate(r.retryAt!)).toBe("2026-11-16");
    // 15/day in week 2: fill it
    for (let i = 0; i < 15; i++) await makeMessage({ status: "sent", sent_at: torontoToUtc("2026-11-10", "09:31"), to_email: `x${i}@y.example` });
    r = await checkSend({ id: "x", type: "first_email", to_email: "a@b.example", clinic_id: clinic }, await getSettings(), tue10);
    expect(r.reason).toMatch(/daily cap 15/);
  });

  it("kill switch and auto-pause stop sales mail but not payment receipts", async () => {
    await db()`update app_settings set kill_switch=true where id`;
    const s = await getSettings();
    expect((await checkSend({ id: "x", type: "first_email", to_email: "a@b.example", clinic_id: null }, s, tue10)).outcome).toBe("defer");
    expect((await checkSend({ id: "x", type: "payment_receipt", to_email: "a@b.example", clinic_id: null }, s, tue10)).outcome).toBe("send");
  });

  it("auto-pauses on any complaint, and on bounces over 3%", async () => {
    await makeMessage({ status: "sent", sent_at: new Date(), dry_run: false, complained_at: new Date() });
    let r = await evaluateAutoPause();
    expect(r.paused).toBe(true);
    expect((await getSettings()).auto_paused).toBe(true);
    // clearing the pause means old events no longer count
    await db()`update app_settings set auto_paused=false, auto_pause_cleared_at=now() where id`;
    // the events below are stamped by this process, the clearing by the database: keep them apart
    await new Promise((r) => setTimeout(r, 250));
    r = await evaluateAutoPause();
    expect(r.paused).toBe(false);
    // 1 bounce in 40 sends = 2.5%: fine
    for (let i = 0; i < 40; i++)
      await makeMessage({ status: "sent", sent_at: new Date(), dry_run: false, to_email: `b${i}@x.example`, bounced_at: i === 0 ? new Date() : null });
    expect((await evaluateAutoPause()).paused).toBe(false);
    // 2 bounces in 41 sends = 4.9%: pause
    await makeMessage({ status: "sent", sent_at: new Date(), dry_run: false, to_email: "c@x.example", bounced_at: new Date() });
    r = await evaluateAutoPause();
    expect(r.paused).toBe(true);
    expect(r.reason).toMatch(/bounce rate/);
  });
});
