import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { decideReview, setTypeMode } from "@/lib/sending/modes";
import * as approval from "@/lib/sending/approval";
import { isSuppressed } from "@/lib/sending/suppression";
import { resetData, makeClinic, makeMessage } from "./helpers";

const actor = { userId: "11111111-1111-1111-1111-111111111111", email: "owner@example.com" };
const decide = (type: string) => db().begin((tx) => decideReview(tx as never, type));

describe("approval modes", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  it("REVIEW is the default for every type", async () => {
    for (const t of ["first_email", "follow_up", "interested_reply", "question_answer", "full_report_delivery", "monthly_report"]) {
      expect((await decide(t)).requiresReview).toBe(true);
    }
  });

  it("payment receipts and unsubscribe confirmations are always automatic", async () => {
    expect((await decide("payment_receipt")).requiresReview).toBe(false);
    expect((await decide("unsubscribe_confirmation")).requiresReview).toBe(false);
  });

  it("after switching to AUTO, the first N still come to review, then it runs alone", async () => {
    await setTypeMode("follow_up", "AUTO", 3);
    const out = [];
    for (let i = 0; i < 5; i++) out.push((await decide("follow_up")).requiresReview);
    expect(out).toEqual([true, true, true, false, false]);
    // other types are unaffected
    expect((await decide("first_email")).requiresReview).toBe(true);
  });

  it("switching back to REVIEW and to AUTO again restarts the first-N count", async () => {
    await setTypeMode("first_email", "AUTO", 1);
    expect((await decide("first_email")).requiresReview).toBe(true);
    expect((await decide("first_email")).requiresReview).toBe(false);
    await setTypeMode("first_email", "REVIEW", 1);
    expect((await decide("first_email")).requiresReview).toBe(true);
    await setTypeMode("first_email", "AUTO", 1);
    expect((await decide("first_email")).requiresReview).toBe(true);
  });

  it("changing a mode does not touch items already in the queue", async () => {
    const id = await makeMessage({ requires_review: true, mode_at_creation: "REVIEW" });
    await setTypeMode("first_email", "AUTO", 0);
    const [m] = await db()`select status::text, requires_review from messages where id=${id}`;
    expect(m).toEqual({ status: "pending_review", requires_review: true });
  });

  it("retest upgrade follows the monthly report switch", async () => {
    await setTypeMode("monthly_report", "AUTO", 0);
    expect((await decide("retest_upgrade")).requiresReview).toBe(false);
  });
});

describe("owner actions", () => {
  beforeEach(resetData);

  it("approve logs the actor and enqueues a send job", async () => {
    const id = await makeMessage();
    await approval.approve(id, actor);
    const [m] = await db()`select status::text from messages where id=${id}`;
    expect(m.status).toBe("approved");
    const [l] = await db()`select action, actor_email from approval_log where message_id=${id}`;
    expect(l).toEqual({ action: "approve", actor_email: "owner@example.com" });
    const [j] = await db()`select kind from jobs where idempotency_key=${"send:" + id}`;
    expect(j.kind).toBe("send_message");
  });

  it("edit saves the change with before/after and approves", async () => {
    const id = await makeMessage();
    await approval.editAndApprove(id, actor, "New subject", "New body");
    const [m] = await db()`select subject, body_text, status::text from messages where id=${id}`;
    expect(m).toEqual({ subject: "New subject", body_text: "New body", status: "approved" });
    const logs = await db()`select action, before, after from approval_log where message_id=${id} order by id`;
    expect(logs[0]).toMatchObject({ action: "edit", before: { subject: "Test subject" }, after: { subject: "New subject" } });
  });

  it("bulk approve refuses items with flags", async () => {
    const ok = await makeMessage();
    const flagged = await makeMessage({ to_email: "z@z.example", flags: db().json([{ code: "x", message: "m", severity: "warn" }]) });
    const res = await approval.bulkApprove([ok, flagged], actor);
    expect(res.find((r) => r.id === ok)?.ok).toBe(true);
    expect(res.find((r) => r.id === flagged)?.ok).toBe(false);
  });

  it("never contact suppresses the address and cancels the clinic's other messages", async () => {
    const clinic = await makeClinic();
    const a = await makeMessage({ clinic_id: clinic });
    const b = await makeMessage({ clinic_id: clinic, type: "follow_up", status: "draft" });
    await approval.neverContact(a, actor);
    expect((await isSuppressed("info@testdental.example")).suppressed).toBe(true);
    const rows = await db()`select status::text from messages where id in (${a}, ${b})`;
    expect(rows.every((r) => r.status === "cancelled")).toBe(true);
  });

  it("cannot approve something already sent", async () => {
    const id = await makeMessage({ status: "sent" });
    await expect(approval.approve(id, actor)).rejects.toThrow(/cannot approve/);
  });
});
