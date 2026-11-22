import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { db, closeDb } from "@/lib/db";
import { resetEnvForTests } from "@/lib/env";
import { startCheckout, resolveBuyToken, alreadyPurchased, reportCredit, requestQuote, dueToday } from "@/lib/payments/checkout";
import { checkoutState, minTermMonths, type CheckoutSessionParams, type StripeLike } from "@/lib/payments/stripe";
import { receiveWebhook, processEvent } from "@/lib/payments/events";
import { loadIntake, submitIntake } from "@/lib/payments/intake";
import { buildAndDeliverFullReport, verifyFullReport } from "@/lib/reports/fullReportJobs";
import { buildFullReportData } from "@/lib/reports/fullReport";
import type { ModelVerifier } from "@/lib/pipeline/verify";
import { handlers } from "@/lib/jobs/handlers";
import "@/lib/payments/jobs";
import { resetData, makeClinic, makeMessage } from "./helpers";
import { HOME, CONTACT, FEES } from "./fixtures/site";

// SYNTHETIC data throughout: invented clinic, invented Stripe ids. No network: the Stripe client is a fake,
// except webhook signatures, which use the real library (it signs and verifies locally).
const SECRET = "whsec_test_secret";
const real = new Stripe("sk_test_not_a_real_key");
const TOKEN = "tok_teaser_0000000000001";

function fakeStripe(price: Partial<{ currency: string; unit_amount: number; active: boolean }> = {}, coupon: Partial<{ valid: boolean; amount_off: number; currency: string; duration: string }> = {}) {
  const created: CheckoutSessionParams[] = [];
  const client: StripeLike = {
    checkout: { sessions: { create: async (p) => { created.push(p); return { id: `cs_test_${created.length}`, url: `https://checkout.stripe.test/pay/${created.length}` }; } } },
    prices: { retrieve: async (id) => ({
      id, active: true, currency: "cad",
      unit_amount: id === "price_growth_monthly" ? 45000 : id === "price_growth_setup" ? 50000 : 20000,
      recurring: id.includes("monthly") ? { interval: "month", interval_count: 1 } : null, ...price,
    }) },
    coupons: { retrieve: async (id) => ({ id, valid: true, amount_off: 20000, currency: "cad", duration: "once", ...coupon }) },
    webhooks: { constructEvent: (payload, header, secret) => real.webhooks.constructEvent(payload, header, secret) as never },
  };
  return { client, created };
}

const ENV_KEYS = ["DRY_RUN", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ONE_TIME", "STRIPE_TAX_RATE_ID",
  "STRIPE_PRICE_VISIBILITY_MONTHLY", "STRIPE_PRICE_GROWTH_MONTHLY", "STRIPE_PRICE_GROWTH_SETUP", "STRIPE_COUPON_REPORT_CREDIT"];
function setEnv(over: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvForTests();
}
/** Everything needed for a real checkout: environment and portal both live. */
async function goLive(over: Record<string, string | undefined> = {}) {
  setEnv({ DRY_RUN: "0", STRIPE_SECRET_KEY: "sk_test_not_a_real_key", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_ONE_TIME: "price_one_time",
    STRIPE_PRICE_VISIBILITY_MONTHLY: "price_visibility_monthly", STRIPE_PRICE_GROWTH_MONTHLY: "price_growth_monthly",
    STRIPE_PRICE_GROWTH_SETUP: "price_growth_setup", STRIPE_COUPON_REPORT_CREDIT: "coupon_report_credit", ...over });
  await db()`update app_settings set dry_run = false, live_enabled = true where id`;
}

async function seedClinic(over: { superseded?: boolean; verified?: boolean; kind?: string } = {}) {
  const sql = db();
  const clinicId = await makeClinic({ name: "Maple Grove Dental", website: "https://maplegrove.example/", domain: "maplegrove.example", status: "contacted" });
  await sql`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary) values (${clinicId}, 'info@maplegrove.example', 'https://maplegrove.example/contact/', true, true)`;
  const [r] = await sql<{ id: string }[]>`
    insert into reports (clinic_id, kind, token, data, html, superseded)
    values (${clinicId}, ${over.kind ?? "teaser"}, ${TOKEN}, ${sql.json({ verified: over.verified ?? true })}, '<html></html>', ${over.superseded ?? false}) returning id`;
  return { clinicId, reportId: r.id };
}

let n = 0;
const event = (type: string, object: Record<string, unknown>, id = `evt_test_${++n}`, created = 1794500000 + n) =>
  ({ id, object: "event", type, created, livemode: false, data: { object } });
async function post(ev: unknown, stripe: StripeLike = fakeStripe().client) {
  const payload = JSON.stringify(ev);
  return receiveWebhook(payload, real.webhooks.generateTestHeaderString({ payload, secret: SECRET }), { stripe });
}
const session = (id: string, clinicId: string, plan: "report" | "visibility" | "growth", extra: Record<string, unknown> = {}) => ({
  id, object: "checkout.session", mode: plan === "report" ? "payment" : "subscription", payment_status: "paid",
  amount_total: 22600, currency: "cad", total_details: { amount_tax: 2600 }, client_reference_id: clinicId,
  customer: "cus_test_1", customer_details: { email: "Owner@MapleGrove.example" },
  payment_intent: plan === "report" ? "pi_test_1" : null, subscription: plan === "report" ? null : "sub_test_1",
  metadata: { clinic_id: clinicId, plan, ...(plan === "growth" ? { min_term_months: "6" } : {}) }, ...extra,
});
const messages = (type: string) => db()<{ id: string; status: string; to_email: string; subject: string; body_text: string; report_id: string | null; attach_pdf: boolean; dry_run: boolean }[]>`
  select id, status::text, to_email, subject, body_text, report_id, attach_pdf, dry_run from messages where type = ${type} order by created_at`;
const jobs = (kind: string) => db()<{ id: string; payload: Record<string, string> }[]>`select id, payload from jobs where kind = ${kind}`;

// the shared test database can be slow to truncate while other suites run beside this one
const SLOW = 180_000;
beforeEach(async () => {
  await resetData();
  setEnv({ STRIPE_WEBHOOK_SECRET: SECRET });
}, SLOW);
afterEach(() => setEnv(Object.fromEntries(ENV_KEYS.map((k) => [k, k === "DRY_RUN" ? "1" : undefined]))));
afterAll(closeDb);

describe("checkout", () => {
  it("refuses in dry run: no session, no order", async () => {
    await seedClinic();
    setEnv({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ONE_TIME: "price_one_time", STRIPE_PRICE_VISIBILITY_MONTHLY: "price_visibility_monthly" });
    const s = fakeStripe();
    for (const plan of ["report", "visibility"] as const) {
      const r = await startCheckout(TOKEN, plan, { stripe: s.client });
      expect(r).toMatchObject({ kind: "closed", reason: "dry run" });
    }
    // environment live but the portal still in dry run
    setEnv({ DRY_RUN: "0" });
    expect(await startCheckout(TOKEN, "report", { stripe: s.client })).toMatchObject({ kind: "closed", reason: "dry run" });
    expect(s.created).toHaveLength(0);
    expect(await db()`select 1 from orders`).toHaveLength(0);
  });

  it("refuses when Stripe is not configured, and a plan while one of its prices is not set", async () => {
    await seedClinic();
    const s = fakeStripe();
    await goLive({ STRIPE_SECRET_KEY: undefined });
    expect(await startCheckout(TOKEN, "report", { stripe: s.client })).toMatchObject({ kind: "closed" });
    await goLive({ STRIPE_WEBHOOK_SECRET: undefined });
    expect((await checkoutState("report")).reason).toMatch(/WEBHOOK/);
    await goLive({ STRIPE_PRICE_ONE_TIME: undefined });
    expect(await startCheckout(TOKEN, "report", { stripe: s.client })).toMatchObject({ kind: "closed" });
    await goLive({ STRIPE_PRICE_GROWTH_SETUP: undefined });
    expect((await checkoutState("growth")).reason).toMatch(/GROWTH_SETUP/);
    expect(await startCheckout(TOKEN, "growth", { stripe: s.client })).toMatchObject({ kind: "closed" });
    expect((await checkoutState("report")).open).toBe(true); // the other plans do not depend on it
    expect((await checkoutState("visibility")).open).toBe(true);
    expect(s.created).toHaveLength(0);
    // the terms come from the offer, not from a setting
    expect(minTermMonths("growth")).toBe(6);
    expect(minTermMonths("visibility")).toBeNull();
    expect(minTermMonths("report")).toBeNull();
  });

  it("creates a payment session and a pending order for the one-time report", async () => {
    const { clinicId, reportId } = await seedClinic();
    await goLive({ STRIPE_TAX_RATE_ID: "txr_hst" });
    const s = fakeStripe();
    const r = await startCheckout(TOKEN, "report", { stripe: s.client });
    expect(r).toEqual({ kind: "redirect", url: "https://checkout.stripe.test/pay/1", sessionId: "cs_test_1" });
    expect(s.created[0]).toMatchObject({
      mode: "payment",
      line_items: [{ price: "price_one_time", quantity: 1, tax_rates: ["txr_hst"] }],
      client_reference_id: clinicId,
      customer_email: "info@maplegrove.example",
      metadata: { clinic_id: clinicId, report_id: reportId, plan: "report" },
      success_url: `https://intheanswer.test/buy/${TOKEN}/report/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://intheanswer.test/buy/${TOKEN}/report/cancel`,
    });
    const orders = await db()`select clinic_id, kind, status, currency, stripe_checkout_session_id from orders`;
    expect(orders).toEqual([{ clinic_id: clinicId, kind: "one_time", status: "pending", currency: "cad", stripe_checkout_session_id: "cs_test_1" }]);
  });

  it("creates a subscription session for Visibility: one monthly price, no minimum term", async () => {
    const { clinicId } = await seedClinic({ superseded: true }); // an old email's link still works
    await goLive();
    const s = fakeStripe();
    const r = await startCheckout(TOKEN, "visibility", { stripe: s.client });
    expect(r.kind).toBe("redirect");
    expect(s.created[0]).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_visibility_monthly", quantity: 1 }],
      subscription_data: { metadata: { clinic_id: clinicId, plan: "visibility" } },
      custom_text: { submit: { message: "Visibility. Month to month. Renews each month until cancelled." } },
    });
    expect(s.created[0].metadata.min_term_months).toBeUndefined();
    expect(s.created[0].discounts).toBeUndefined();
    expect(await db()`select kind, plan, status, credit_cents from orders`).toEqual([{ kind: "subscription", plan: "visibility", status: "pending", credit_cents: 0 }]);
  });

  it("Growth: 450 a month plus the 500 setup on the first invoice, with a 6-month minimum", async () => {
    const { clinicId } = await seedClinic();
    await goLive({ STRIPE_TAX_RATE_ID: "txr_hst" });
    const s = fakeStripe();
    const r = await startCheckout(TOKEN, "growth", { stripe: s.client, expectCents: 95000 });
    expect(r.kind).toBe("redirect");
    expect(s.created[0]).toMatchObject({
      mode: "subscription",
      line_items: [
        { price: "price_growth_monthly", quantity: 1, tax_rates: ["txr_hst"] },
        { price: "price_growth_setup", quantity: 1, tax_rates: ["txr_hst"] },
      ],
      subscription_data: { metadata: { clinic_id: clinicId, plan: "growth", min_term_months: "6" } },
      custom_text: { submit: { message: "Growth. Minimum term 6 months, then month to month. Renews each month until cancelled." } },
    });
    expect(await db()`select kind, plan, status from orders`).toEqual([{ kind: "subscription", plan: "growth", status: "pending" }]);
    // refused when a price is not the published one (here the setup is charged as 200)
    const wrong = fakeStripe({ unit_amount: 20000 });
    expect((await startCheckout(TOKEN, "growth", { stripe: wrong.client })).kind).toBe("closed");
    expect(wrong.created).toHaveLength(0);
  });

  it("Visibility paid: a subscription with no minimum term, an onboarding task but no intake form, its own receipt", async () => {
    const { clinicId } = await seedClinic();
    const sql = db();
    await goLive();
    const s = fakeStripe();
    await startCheckout(TOKEN, "visibility", { stripe: s.client });
    await post(event("checkout.session.completed", session("cs_test_1", clinicId, "visibility", { amount_total: 22600, total_details: { amount_tax: 2600 } })));
    const [sub] = await sql`select plan, status, min_term_end from subscriptions`;
    expect(sub).toMatchObject({ plan: "visibility", status: "active", min_term_end: null });
    expect(await sql`select 1 from intake_forms`).toHaveLength(0);
    const tasks = await sql`select title, body from owner_tasks where kind = 'onboarding'`;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Onboard Maple Grove Dental (Visibility)");
    expect(tasks[0].body).toMatch(/access to the clinic's website/);
    const [rcpt] = await messages("payment_receipt");
    expect(rcpt.subject).toBe("Receipt: In The Answer Visibility plan");
    expect(rcpt.body_text).toContain("Item: Visibility plan, 200 CAD billed each month by card");
    expect(rcpt.body_text).toContain("It runs month to month.");
    expect(rcpt.body_text).not.toContain("minimum term");
    expect(await jobs("build_full_report")).toHaveLength(1);
    // nothing more can be bought online while the plan runs; moving up is arranged by email
    expect(await alreadyPurchased(clinicId, "report")).toBe("visibility");
    expect(await alreadyPurchased(clinicId, "growth")).toBe("visibility");
  });

  it("credits the full report against the first month of a plan started within 30 days, once", async () => {
    const { clinicId } = await seedClinic();
    const sql = db();
    await goLive();
    const [paid] = await sql<{ id: string }[]>`
      insert into orders (clinic_id, kind, plan, status, paid_at) values (${clinicId}, 'one_time', 'report', 'paid', now() - interval '10 days') returning id`;
    expect(await reportCredit(clinicId)).toEqual({ orderId: paid.id, cents: 20000 });
    expect(await dueToday(clinicId, "growth")).toMatchObject({ cents: 75000 });
    expect(await dueToday(clinicId, "visibility")).toMatchObject({ cents: 0 });
    expect((await dueToday(clinicId, "report")).credit).toBeNull();

    // the page showed the full price (opened before the report was paid): nothing is created, the page is shown again
    const s = fakeStripe();
    expect(await startCheckout(TOKEN, "growth", { stripe: s.client, expectCents: 95000 })).toEqual({ kind: "changed" });
    expect(s.created).toHaveLength(0);

    const r = await startCheckout(TOKEN, "growth", { stripe: s.client, expectCents: 75000 });
    expect(r.kind).toBe("redirect");
    expect(s.created[0].discounts).toEqual([{ coupon: "coupon_report_credit" }]);
    expect(s.created[0].metadata.credit_order_id).toBe(paid.id);
    const [order] = await sql`select credit_cents, credit_order_id from orders where kind = 'subscription'`;
    expect(order).toEqual({ credit_cents: 20000, credit_order_id: paid.id });

    // paid: the receipt shows the credit, and the same report is never credited twice
    await post(event("checkout.session.completed", session("cs_test_1", clinicId, "growth", { amount_total: 84750, total_details: { amount_tax: 9750, amount_discount: 20000 } })));
    const [rcpt] = await messages("payment_receipt");
    expect(rcpt.body_text).toContain("Item: Growth plan, 450 CAD billed each month by card (this first payment includes the 500 CAD setup)");
    expect(rcpt.body_text).toContain("Credit: 200.00 CAD, the price of the full report you bought, taken off this first payment");
    expect(rcpt.body_text).toMatch(/minimum term is 6 months, to .*; after that it runs month to month\./);
    expect(await reportCredit(clinicId)).toBeNull();
  });

  it("gives no credit for an old, refunded or missing report, and refuses to charge full price when the coupon is not set up", async () => {
    const { clinicId } = await seedClinic();
    const sql = db();
    await goLive();
    expect(await reportCredit(clinicId)).toBeNull();
    const [o] = await sql<{ id: string }[]>`
      insert into orders (clinic_id, kind, plan, status, paid_at) values (${clinicId}, 'one_time', 'report', 'paid', now() - interval '31 days') returning id`;
    expect(await reportCredit(clinicId)).toBeNull();
    await sql`update orders set paid_at = now() - interval '2 days', status = 'refunded' where id = ${o.id}`;
    expect(await reportCredit(clinicId)).toBeNull();
    await sql`update orders set status = 'paid' where id = ${o.id}`;
    expect(await reportCredit(clinicId)).not.toBeNull();

    // the credit is published: a clinic that qualifies is never charged the full amount
    await goLive({ STRIPE_COUPON_REPORT_CREDIT: undefined });
    const s = fakeStripe();
    expect(await startCheckout(TOKEN, "visibility", { stripe: s.client })).toMatchObject({ kind: "closed" });
    await goLive();
    const wrongCoupon = fakeStripe({}, { amount_off: 5000 });
    expect(await startCheckout(TOKEN, "visibility", { stripe: wrongCoupon.client })).toMatchObject({ kind: "closed" });
    const forever = fakeStripe({}, { duration: "forever" });
    expect(await startCheckout(TOKEN, "visibility", { stripe: forever.client })).toMatchObject({ kind: "closed" });
    expect(s.created.length + wrongCoupon.created.length + forever.created.length).toBe(0);
    expect((await messages("owner_alert")).map((m) => m.subject)).toEqual(expect.arrayContaining([
      "Checkout refused: the report credit is not set up", "Checkout refused: Stripe coupon does not match",
    ]));
  });

  it("takes a request for a quote for the plan that is never bought online: a task and an alert, no payment", async () => {
    const { clinicId } = await seedClinic();
    const sql = db();
    expect(await requestQuote("tok_unknown_000000000000", {})).toEqual({ ok: false, reason: "not_found" });
    expect(await requestQuote(TOKEN, { phone: "705-555-0142", bestTime: "Tuesday after 2", note: "Connect our booking\nsystem" })).toEqual({ ok: true });
    const tasks = await sql`select kind, clinic_id, title, body, status from owner_tasks`;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "quote_request", clinic_id: clinicId, status: "open", title: "Quote request: Maple Grove Dental (Transformation)" });
    expect(tasks[0].body).toContain("Phone: 705-555-0142");
    expect(tasks[0].body).toContain("What they wrote: Connect our booking system");
    // asking again while the request is open adds nothing
    expect(await requestQuote(TOKEN, { phone: "705-555-0142" })).toEqual({ ok: true });
    expect(await sql`select 1 from owner_tasks`).toHaveLength(1);
    expect((await messages("owner_alert")).filter((m) => m.subject.startsWith("Quote request"))).toHaveLength(1);
    expect(await sql`select 1 from orders`).toHaveLength(0);
  });

  it("does not accept a sample, an unverified draft or an unknown token", async () => {
    await goLive();
    const s = fakeStripe();
    expect(await startCheckout("nope", "report", { stripe: s.client })).toEqual({ kind: "not_found" });
    expect(await startCheckout("tok_unknown_000000000000", "report", { stripe: s.client })).toEqual({ kind: "not_found" });
    await seedClinic({ verified: false });
    expect(await resolveBuyToken(TOKEN)).toBeNull();
    await resetData();
    await seedClinic({ kind: "sample" });
    expect(await startCheckout(TOKEN, "report", { stripe: s.client })).toEqual({ kind: "not_found" });
    expect(s.created).toHaveLength(0);
  }, SLOW);

  it("does not charge twice: a paid report or a running plan shows a notice instead", async () => {
    const { clinicId } = await seedClinic();
    await goLive();
    const s = fakeStripe();
    const sql = db();
    await sql`insert into orders (clinic_id, kind, status, paid_at) values (${clinicId}, 'one_time', 'paid', now())`;
    expect(await startCheckout(TOKEN, "report", { stripe: s.client })).toEqual({ kind: "already", has: "report" });
    expect(await alreadyPurchased(clinicId, "growth")).toBeNull(); // the report buyer may still move to a plan
    await sql`insert into subscriptions (clinic_id, stripe_subscription_id, plan, status) values (${clinicId}, 'sub_x', 'growth', 'active')`;
    expect(await startCheckout(TOKEN, "growth", { stripe: s.client })).toEqual({ kind: "already", has: "growth" });
    expect(await startCheckout(TOKEN, "report", { stripe: s.client })).toEqual({ kind: "already", has: "growth" });
    // a subscription from before the plans changed still blocks a second purchase, under its old name
    await sql`update subscriptions set plan = 'monthly'`;
    expect(await startCheckout(TOKEN, "visibility", { stripe: s.client })).toEqual({ kind: "already", has: "monthly" });
    // one made by hand in Stripe that names no plan counts as the largest
    await sql`update subscriptions set plan = null`;
    expect(await alreadyPurchased(clinicId, "growth")).toBe("transformation");
    await sql`update subscriptions set status = 'canceled'`;
    expect(await alreadyPurchased(clinicId, "growth")).toBeNull();
    expect(s.created).toHaveLength(0);
  });

  it("refuses and alerts the owner when the Stripe price is not the published one", async () => {
    await seedClinic();
    await goLive();
    const s = fakeStripe({ currency: "usd" });
    expect(await startCheckout(TOKEN, "report", { stripe: s.client })).toMatchObject({ kind: "closed" });
    expect(s.created).toHaveLength(0);
    expect(await messages("owner_alert")).toHaveLength(1);
    const wrongAmount = fakeStripe({ unit_amount: 2000 });
    expect(await startCheckout(TOKEN, "visibility", { stripe: wrongAmount.client })).toMatchObject({ kind: "closed" });
  });

  it("limits how many sessions one clinic can open in an hour", async () => {
    await seedClinic();
    await goLive();
    const s = fakeStripe();
    for (let i = 0; i < 6; i++) expect((await startCheckout(TOKEN, "report", { stripe: s.client })).kind).toBe("redirect");
    expect(await startCheckout(TOKEN, "report", { stripe: s.client })).toEqual({ kind: "busy" });
  });
});

describe("stripe webhook", () => {
  it("rejects a bad or missing signature and stores nothing", async () => {
    const { clinicId } = await seedClinic();
    const payload = JSON.stringify(event("checkout.session.completed", session("cs_a", clinicId, "report")));
    const stripe = fakeStripe().client;
    expect((await receiveWebhook(payload, null, { stripe })).status).toBe(400);
    expect((await receiveWebhook(payload, "t=1,v1=deadbeef", { stripe })).status).toBe(400);
    const wrongSecret = real.webhooks.generateTestHeaderString({ payload, secret: "whsec_other" });
    expect((await receiveWebhook(payload, wrongSecret, { stripe })).status).toBe(400);
    // signed for a different body
    const good = real.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    expect((await receiveWebhook(payload.replace("22600", "1"), good, { stripe })).status).toBe(400);
    expect(await db()`select 1 from stripe_events`).toHaveLength(0);
    expect(await db()`select 1 from orders`).toHaveLength(0);
    setEnv({ STRIPE_WEBHOOK_SECRET: undefined });
    expect((await receiveWebhook(payload, good, { stripe })).status).toBe(503);
  });

  it("checkout.session.completed, one-time: order paid, clinic a customer, cold mail stopped, receipt, fulfilment", async () => {
    const { clinicId } = await seedClinic();
    const sql = db();
    await sql`insert into orders (clinic_id, kind, stripe_checkout_session_id, status, customer_email) values (${clinicId}, 'one_time', 'cs_a', 'pending', 'info@maplegrove.example')`;
    const followUp = await makeMessage({ clinic_id: clinicId, type: "follow_up", status: "approved" });
    const sentFirst = await makeMessage({ clinic_id: clinicId, type: "first_email", status: "sent" });
    const other = await makeMessage({ type: "follow_up", status: "approved" }); // another clinic's mail is untouched

    const ev = event("checkout.session.completed", session("cs_a", clinicId, "report"));
    expect((await post(ev)).status).toBe(200);

    const [o] = await sql`select status, amount_cents, currency, customer_email, stripe_payment_intent_id, stripe_customer_id, paid_at from orders`;
    expect(o).toMatchObject({ status: "paid", amount_cents: 22600, currency: "cad", customer_email: "owner@maplegrove.example", stripe_payment_intent_id: "pi_test_1", stripe_customer_id: "cus_test_1" });
    expect(o.paid_at).toBeInstanceOf(Date);
    expect((await sql`select status::text from clinics where id = ${clinicId}`)[0].status).toBe("customer");
    const st = async (id: string) => (await sql`select status::text from messages where id = ${id}`)[0].status;
    expect(await st(followUp)).toBe("cancelled");
    expect(await st(sentFirst)).toBe("sent");
    expect(await st(other)).toBe("approved");

    const receipts = await messages("payment_receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: "approved", to_email: "owner@maplegrove.example", dry_run: true });
    expect(receipts[0].body_text).toContain("Amount paid: 226.00 CAD (includes 26.00 CAD HST)");
    expect(receipts[0].body_text).toContain("Refunds for the one-time report are given when the report has not yet been delivered.");
    expect(await jobs("send_message")).toHaveLength(1);
    const builds = await jobs("build_full_report");
    expect(builds).toHaveLength(1);
    expect(builds[0].payload.orderId).toBeTruthy();
    expect(await sql`select 1 from subscriptions`).toHaveLength(0);
    expect(await sql`select 1 from intake_forms`).toHaveLength(0);
    const [stored] = await sql`select type, processed_at, error from stripe_events`;
    expect(stored).toMatchObject({ type: "checkout.session.completed", error: null });
    expect(stored.processed_at).toBeInstanceOf(Date);
  });

  it("is idempotent: the same event twice makes one transition, one receipt, one build", async () => {
    const { clinicId } = await seedClinic();
    const sql = db();
    await sql`insert into orders (clinic_id, kind, stripe_checkout_session_id, status) values (${clinicId}, 'one_time', 'cs_a', 'pending')`;
    const ev = event("checkout.session.completed", session("cs_a", clinicId, "report"));
    await post(ev);
    const [first] = await sql`select paid_at from orders`;
    // the clinic is changed by hand afterwards: a replay must not touch it again
    await sql`update clinics set status = 'closed' where id = ${clinicId}`;
    expect((await post(ev)).status).toBe(200);
    expect(await processEvent(ev.id)).toBe("already");
    await handlers.stripe_event({ job: { id: "j", kind: "stripe_event", idempotency_key: "k", payload: { eventId: ev.id }, attempts: 1, max_attempts: 5 } } as never);

    expect(await sql`select 1 from stripe_events`).toHaveLength(1);
    expect(await sql`select 1 from orders`).toHaveLength(1);
    expect((await sql`select paid_at from orders`)[0].paid_at).toEqual(first.paid_at);
    expect((await sql`select status::text from clinics where id = ${clinicId}`)[0].status).toBe("closed");
    expect(await messages("payment_receipt")).toHaveLength(1);
    expect(await jobs("build_full_report")).toHaveLength(1);
    expect(await jobs("stripe_event")).toHaveLength(1);

    // Stripe can also send a second, different event for the same session
    await post(event("checkout.session.completed", session("cs_a", clinicId, "report")));
    expect(await messages("payment_receipt")).toHaveLength(1);
    expect(await jobs("build_full_report")).toHaveLength(1);
    expect((await sql`select status::text from clinics where id = ${clinicId}`)[0].status).toBe("closed");
  });

  it("checkout.session.completed, Growth: subscription with minimum term, intake form, onboarding task, receipt, fulfilment", async () => {
    const { clinicId } = await seedClinic();
    const sql = db();
    await sql`insert into orders (clinic_id, kind, stripe_checkout_session_id, status) values (${clinicId}, 'subscription', 'cs_m', 'pending')`;
    const ev = event("checkout.session.completed", session("cs_m", clinicId, "growth"));
    await post(ev);
    await post(ev);

    const [o] = await sql`select id, status, kind, stripe_subscription_id, paid_at from orders`;
    expect(o).toMatchObject({ status: "paid", kind: "subscription", stripe_subscription_id: "sub_test_1" });
    expect((await sql`select status::text from clinics where id = ${clinicId}`)[0].status).toBe("customer");
    const subs = await sql`select clinic_id, stripe_customer_id, status, min_term_end from subscriptions`;
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ clinic_id: clinicId, stripe_customer_id: "cus_test_1", status: "active" });
    const term = new Date(o.paid_at as Date);
    term.setUTCMonth(term.getUTCMonth() + 6);
    expect(Math.abs((subs[0].min_term_end as Date).getTime() - term.getTime())).toBeLessThan(2 * 86400e3);

    const forms = await sql`select token, order_id, submitted_at from intake_forms`;
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({ order_id: o.id, submitted_at: null });
    const tasks = await sql`select kind, status, clinic_id, order_id from owner_tasks`;
    expect(tasks).toEqual([{ kind: "onboarding", status: "open", clinic_id: clinicId, order_id: o.id }]);
    const receipts = await messages("payment_receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].body_text).toMatch(/renews each month until it is cancelled\. The minimum term is 6 months, to /);
    expect(await jobs("build_full_report")).toHaveLength(1);

    // later subscription events keep the row current; an older event does not undo a newer one
    const sub = (status: string, extra: Record<string, unknown> = {}) => ({ id: "sub_test_1", object: "subscription", status, customer: "cus_test_1",
      metadata: { clinic_id: clinicId, plan: "growth", min_term_months: "6" }, items: { data: [{ current_period_end: 1797100000 }] }, cancel_at: null, canceled_at: null, ...extra });
    await post(event("customer.subscription.created", sub("incomplete")));
    expect((await sql`select status from subscriptions`)[0].status).toBe("active");
    await post(event("invoice.paid", { id: "in_1", parent: { subscription_details: { subscription: "sub_test_1" } }, lines: { data: [{ period: { end: 1797100000 } }] } }));
    expect(((await sql`select current_period_end from subscriptions`)[0].current_period_end as Date).getTime()).toBe(1797100000 * 1000);
    await post(event("invoice.payment_failed", { id: "in_2", subscription: "sub_test_1", amount_due: 22600, currency: "cad", attempt_count: 1 }));
    expect((await sql`select status from subscriptions`)[0].status).toBe("past_due");
    expect(await sql`select 1 from owner_tasks where kind = 'alert' and clinic_id = ${clinicId}`).toHaveLength(1);
    expect((await messages("owner_alert")).map((m) => m.subject)).toContain("Monthly payment failed: Maple Grove Dental");
    await post(event("customer.subscription.updated", sub("active"), "evt_new", 1794600100));
    await post(event("customer.subscription.updated", sub("past_due"), "evt_old", 1794600000));
    expect((await sql`select status from subscriptions`)[0].status).toBe("active");
    await post(event("customer.subscription.deleted", sub("canceled", { canceled_at: 1794700000 }), "evt_del", 1794700000));
    const [ended] = await sql`select status, canceled_at, min_term_end from subscriptions`;
    expect(ended.status).toBe("canceled");
    expect((ended.canceled_at as Date).getTime()).toBe(1794700000 * 1000);
    const alert = (await messages("owner_alert")).find((m) => m.subject === "Growth ended: Maple Grove Dental");
    expect(alert?.body_text).toMatch(/before the end of the minimum term/);
    expect(await alreadyPurchased(clinicId, "growth")).toBeNull();
  });

  it("rebuilds a missing order from the session metadata, and waits for a delayed payment", async () => {
    const { clinicId } = await seedClinic();
    const sql = db();
    await post(event("checkout.session.completed", session("cs_late", clinicId, "report", { payment_status: "unpaid" })));
    expect(await sql`select status from orders`).toEqual([{ status: "pending" }]);
    expect(await messages("payment_receipt")).toHaveLength(0);
    await post(event("checkout.session.async_payment_succeeded", session("cs_late", clinicId, "report")));
    expect(await sql`select status from orders`).toEqual([{ status: "paid" }]);
    expect(await messages("payment_receipt")).toHaveLength(1);
    // a session that names no clinic of ours: nothing is delivered, the owner is told
    await post(event("checkout.session.completed", session("cs_x", "00000000-0000-4000-8000-000000000000", "report")));
    expect(await sql`select 1 from orders`).toHaveLength(1);
    expect((await messages("owner_alert"))[0].subject).toMatch(/could not be matched/);
  });

  it("a second payment for the same report is not fulfilled twice", async () => {
    const { clinicId } = await seedClinic();
    await post(event("checkout.session.completed", session("cs_1", clinicId, "report")));
    await post(event("checkout.session.completed", session("cs_2", clinicId, "report", { payment_intent: "pi_test_2" })));
    expect(await db()`select 1 from orders where status = 'paid'`).toHaveLength(2);
    expect(await jobs("build_full_report")).toHaveLength(1);
    expect((await messages("owner_alert")).map((m) => m.subject)).toContain("Possible double payment: Maple Grove Dental");
  });

  it("charge.refunded: order refunded or partially refunded, owner alerted, unsent delivery cancelled", async () => {
    const { clinicId } = await seedClinic();
    const sql = db();
    await post(event("checkout.session.completed", session("cs_a", clinicId, "report")));
    const [o] = await sql<{ id: string }[]>`select id from orders`;
    const delivery = await makeMessage({ clinic_id: clinicId, type: "full_report_delivery", status: "pending_review", idempotency_key: `delivery:${o.id}` });

    await post(event("charge.refunded", { id: "ch_1", payment_intent: "pi_test_1", amount: 22600, amount_refunded: 5000, refunded: false, currency: "cad" }));
    let [row] = await sql`select status, amount_refunded_cents, refunded_at from orders`;
    expect(row).toMatchObject({ status: "partially_refunded", amount_refunded_cents: 5000 });
    expect((await sql`select status::text from messages where id = ${delivery}`)[0].status).toBe("pending_review");

    await post(event("charge.refunded", { id: "ch_1", payment_intent: "pi_test_1", amount: 22600, amount_refunded: 22600, refunded: true, currency: "cad" }));
    [row] = await sql`select status, amount_refunded_cents, refunded_at from orders`;
    expect(row).toMatchObject({ status: "refunded", amount_refunded_cents: 22600 });
    expect(row.refunded_at).toBeInstanceOf(Date);
    expect((await sql`select status::text from messages where id = ${delivery}`)[0].status).toBe("cancelled");
    const alerts = (await messages("owner_alert")).map((m) => m.subject);
    expect(alerts).toEqual(expect.arrayContaining(["Partial refund: Maple Grove Dental", "Refund: Maple Grove Dental"]));
    // a refunded order is never built
    expect(await buildAndDeliverFullReport(o.id, { verifier: null })).toEqual({ skipped: "order is refunded" });
    // a refund we cannot match changes nothing
    await post(event("charge.refunded", { id: "ch_9", payment_intent: "pi_unknown", amount: 100, amount_refunded: 100, refunded: true, currency: "cad" }));
    expect(await sql`select 1 from orders where status = 'refunded'`).toHaveLength(1);
  });

  it("checkout.session.expired fails the pending order; unknown events are stored and marked processed", async () => {
    const { clinicId } = await seedClinic();
    const sql = db();
    await sql`insert into orders (clinic_id, kind, stripe_checkout_session_id, status) values (${clinicId}, 'one_time', 'cs_e', 'pending')`;
    await post(event("checkout.session.expired", { id: "cs_e" }));
    expect(await sql`select status from orders`).toEqual([{ status: "failed" }]);
    await post(event("payment_method.attached", { id: "pm_1" }, "evt_unknown"));
    const [u] = await sql`select type, processed_at, error from stripe_events where id = 'evt_unknown'`;
    expect(u.type).toBe("payment_method.attached");
    expect(u.processed_at).toBeInstanceOf(Date);
    expect(await messages("payment_receipt")).toHaveLength(0);
  });
});

describe("intake form", () => {
  async function seedIntake() {
    const { clinicId } = await seedClinic();
    await post(event("checkout.session.completed", session("cs_m", clinicId, "growth")));
    const [f] = await db()<{ token: string }[]>`select token from intake_forms`;
    return { clinicId, token: f.token };
  }
  const answers = { contact_name: "Dana Lee, office manager", site_contact: "Sam at Webworks, sam@webworks.example", approver: "Dr. Lee, lee@maplegrove.example",
    booking_link: "https://maplegrove.example/book", changes: "Update the hours first.", notes: "" };

  it("stores the answers once, updates the onboarding task and tells the owner", async () => {
    const { clinicId, token } = await seedIntake();
    expect(await loadIntake(token)).toMatchObject({ clinicName: "Maple Grove Dental", submitted: false });
    expect(await submitIntake(token, answers)).toEqual({ ok: true });
    const sql = db();
    const [f] = await sql`select answers, submitted_at from intake_forms`;
    expect(f.submitted_at).toBeInstanceOf(Date);
    expect(f.answers).toMatchObject({ contact_name: "Dana Lee, office manager", booking_link: "https://maplegrove.example/book" });
    expect(f.answers).not.toHaveProperty("notes");
    const tasks = await sql`select title, body, status from owner_tasks where kind = 'onboarding' and clinic_id = ${clinicId}`;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Onboard Maple Grove Dental: intake received");
    expect(tasks[0].body).toContain("Sam at Webworks");
    expect((await messages("owner_alert")).map((m) => m.subject)).toContain("Intake form received: Maple Grove Dental");

    expect(await submitIntake(token, { ...answers, changes: "Something else" })).toMatchObject({ ok: false, error: "already" });
    expect((await sql`select answers from intake_forms`)[0].answers.changes).toBe("Update the hours first.");
    expect((await loadIntake(token))?.submitted).toBe(true);
  });

  it("rejects an empty form, missing fields, a password and a bad link, and still accepts a corrected one", async () => {
    const { token } = await seedIntake();
    expect(await submitIntake(token, {})).toMatchObject({ ok: false, error: "invalid" });
    expect(await submitIntake(token, { contact_name: "Dana" })).toMatchObject({ ok: false, error: "invalid" });
    const pw = await submitIntake(token, { ...answers, notes: "WordPress login admin, password: hunter2" });
    expect(pw).toMatchObject({ ok: false, error: "invalid" });
    expect((pw as { message: string }).message).toMatch(/Never send passwords/);
    expect(await submitIntake(token, { ...answers, booking_link: "javascript:alert(1)" })).toMatchObject({ ok: false, error: "invalid" });
    expect((await db()`select answers, submitted_at from intake_forms`)[0]).toMatchObject({ answers: null, submitted_at: null });
    expect(await submitIntake(token, answers)).toEqual({ ok: true });
    expect(await submitIntake("tok_unknown_000000000000", answers)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("limits tries per token", async () => {
    const { token } = await seedIntake();
    for (let i = 0; i < 5; i++) expect(await submitIntake(token, {})).toMatchObject({ error: "invalid" });
    expect(await submitIntake(token, answers)).toMatchObject({ ok: false, error: "rate_limited" });
    await db()`update intake_forms set attempt_window_start = now() - interval '2 hours'`;
    expect(await submitIntake(token, answers)).toEqual({ ok: true });
  });
});

describe("build_full_report", () => {
  const allSupported: ModelVerifier = async (items) => ({
    verdicts: items.map((i) => ({ id: i.id, supported: true, issue: "none" as const, explanation: "" })), usage: null, costUsd: 0,
  });
  const stored: string[] = [];
  const deps = { verifier: allSupported, pdf: async () => Buffer.from("%PDF-test"), store: async (key: string) => { stored.push(key); return `local:${key}`; } };

  /** Evidence for the report: cached pages, an audit with gaps, test results and a score. */
  async function seedEvidence(clinicId: string) {
    const sql = db();
    for (const [u, h] of [["https://maplegrove.example/", HOME], ["https://maplegrove.example/contact/", CONTACT], ["https://maplegrove.example/fees", FEES]]) {
      await sql`insert into page_cache (url, domain, http_status, content_type, body) values (${u}, 'maplegrove.example', 200, 'text/html', ${h})`;
    }
    const [qs] = await sql<{ id: number; sector_id: number }[]>`select q.id, q.sector_id from question_sets q join sectors s on s.id=q.sector_id where s.slug='dental'`;
    const [city] = await sql<{ id: number }[]>`select id from cities where name='Barrie'`;
    const [run] = await sql<{ id: string }[]>`
      insert into test_runs (sector_id, city_id, question_set_id, assistant, model, run_label, finished_at)
      values (${qs.sector_id}, ${city.id}, ${qs.id}, 'Claude', 'claude-opus-5-5', 'test', '2026-11-10T15:00:00Z') returning id`;
    for (let i = 0; i < 6; i++) {
      const [a] = await sql<{ id: string }[]>`
        insert into test_answers (test_run_id, question_index, question, answer_text) values (${run.id}, ${i}, ${"Question " + (i + 1)}, 'Lakeshore Dental Studio is accepting new patients.') returning id`;
      await sql`insert into clinic_test_results (clinic_id, test_answer_id, status) values (${clinicId}, ${a.id}, ${i === 0 ? "recommended" : "not_named"})`;
    }
    const [audit] = await sql<{ id: string }[]>`insert into audits (clinic_id, pages_read) values (${clinicId}, ${["https://maplegrove.example/"]}) returning id`;
    const checks = [
      { k: "hours_conflict", result: "found", gap: true, sev: 90, text: "Two different sets of hours appear on your site.",
        ev: [{ kind: "page_quote", url: "https://maplegrove.example/", quote: "Monday to Friday 9:00 am to 5:00 pm" }, { kind: "page_quote", url: "https://maplegrove.example/contact/", quote: "Monday to Friday 8:00 am to 4:00 pm" }] },
      { k: "outdated_notices", result: "found", gap: true, sev: 70, text: "Your site still shows a notice that appears out of date.",
        ev: [{ kind: "page_quote", url: "https://maplegrove.example/fees", quote: "masks are required in the clinic during the COVID-19 pandemic" }] },
      { k: "languages", result: "not_found", gap: true, sev: 30, text: "We did not find the languages spoken at the clinic on the 3 pages we read.", ev: [{ kind: "pages_read", label: "3 pages" }] },
      { k: "fees", result: "could_not_verify", gap: true, sev: 99, text: "You do not publish fees.", ev: [] },
    ];
    for (const c of checks) {
      await sql`insert into audit_checks (audit_id, check_key, result, summary, evidence, is_gap, severity, finding_text)
                values (${audit.id}, ${c.k}, ${c.result}, 's', ${sql.json(c.ev)}, ${c.gap}, ${c.sev}, ${c.text})`;
    }
    await sql`insert into scores (clinic_id, test_run_id, audit_id, recommended, listed_only, not_named, total, confirmed_findings, qualifies, reason)
              values (${clinicId}, ${run.id}, ${audit.id}, 1, 0, 5, 6, 3, true, 'ok')`;
  }
  async function paidOrder(plan: "report" | "visibility" | "growth" = "report") {
    const { clinicId } = await seedClinic();
    await seedEvidence(clinicId);
    await post(event("checkout.session.completed", session("cs_a", clinicId, plan)));
    const [o] = await db()<{ id: string }[]>`select id from orders`;
    return { clinicId, orderId: o.id };
  }

  it("builds, verifies, stores and queues the delivery once per order", async () => {
    const { clinicId, orderId } = await paidOrder();
    const sql = db();
    const r1 = await buildAndDeliverFullReport(orderId, deps);
    expect(r1).toMatchObject({ built: true, findings: 3, status: "pending_review" });
    const r2 = await buildAndDeliverFullReport(orderId, deps);
    expect(r2).toMatchObject({ built: false, reportId: r1.reportId, message: r1.message });
    // and through the registered job handler
    await handlers.build_full_report({ job: { id: "j", kind: "build_full_report", idempotency_key: "k", payload: { orderId }, attempts: 1, max_attempts: 5 }, cost: async () => {} } as never);

    const reports = await sql`select id, clinic_id, kind, token, data, html, pdf_path, pdf_bytes from reports where kind = 'full'`;
    expect(reports).toHaveLength(1);
    const rep = reports[0];
    expect(rep).toMatchObject({ clinic_id: clinicId, pdf_bytes: 9 });
    expect(rep.pdf_path).toBe(`local:reports/${rep.token}.pdf`);
    expect(stored).toHaveLength(1);
    expect(rep.data).toMatchObject({ kind: "full", verified: true, orderId, score: { recommended: 1, total: 6 } });
    expect(rep.data.findings.map((f: { key: string }) => f.key)).toEqual(["hours_conflict", "outdated_notices", "languages"]);
    expect(rep.html).toContain("Two different sets of hours appear on your site.");
    expect(rep.html).not.toContain("You do not publish fees"); // could not verify: never stated
    expect(rep.html).not.toContain(`/buy/${TOKEN}/monthly`); // no link to a retired plan
    expect((await sql`select report_id from orders where id = ${orderId}`)[0].report_id).toBe(rep.id);

    const mails = await messages("full_report_delivery");
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to_email: "owner@maplegrove.example", report_id: rep.id, attach_pdf: true, subject: "Your full report: Maple Grove Dental" });
    expect(mails[0].body_text).toContain(`https://intheanswer.test/r/${rep.token}`);
    expect(mails[0].body_text).toContain(["In the report:", "- 3 findings, each with what we saw and the fix", "- your fix files", "", "A PDF copy is attached."].join("\n"));
    expect(mails[0].body_text).not.toContain("/intake/");
  });

  it("removes what no longer holds; a report the model pass did not check is held", async () => {
    const { orderId, clinicId } = await paidOrder();
    const sql = db();
    await sql`update page_cache set body = '<html><body>Hours vary.</body></html>' where url = 'https://maplegrove.example/contact/'`;
    const raw = await buildFullReportData(clinicId);
    const dropOne: ModelVerifier = async (items) => ({
      verdicts: items.map((i) => ({ id: i.id, supported: i.id !== "finding-1", issue: i.id === "finding-1" ? ("overstated" as const) : ("none" as const), explanation: "test" })), usage: null, costUsd: 0,
    });
    const gate = await verifyFullReport(raw, { live: false, verifier: dropOne });
    expect(gate.removed.map((x) => x.what)).toEqual(["Hours that disagree", expect.any(String)]);
    expect(gate.data.findings.map((f) => f.key)).toEqual(["outdated_notices"]);
    expect(gate.flags.filter((f) => f.severity === "block")).toEqual([]);

    // a tampered score and a finding that is not in the stored checks
    const bad = structuredClone(raw);
    bad.score = { recommended: 5, total: 6 };
    bad.findings.push({ key: "fees", label: "Fees", seen: "You do not publish fees.", fix: "", evidence: [] });
    bad.findings.push({ key: "languages", label: "Languages", seen: "Your clinic is the best in Barrie.", fix: "", evidence: [] });
    const g2 = await verifyFullReport(bad, { live: false, verifier: allSupported });
    expect(g2.data.score).toBeNull();
    expect(g2.flags.map((f) => f.code)).toContain("score_mismatch");
    expect(g2.data.findings.some((f) => f.key === "fees" || f.seen.includes("best"))).toBe(false);

    const held = await buildAndDeliverFullReport(orderId, { ...deps, verifier: null });
    expect(held).toMatchObject({ status: "held" });
    const [m] = await messages("full_report_delivery");
    expect(m.status).toBe("held");
    expect(await jobs("send_message")).toHaveLength(1); // the receipt only
  });

  it("Growth: the first delivery carries the full report and the intake link", async () => {
    const { orderId } = await paidOrder("growth");
    const r = await buildAndDeliverFullReport(orderId, deps);
    expect(r).toMatchObject({ built: true });
    const [f] = await db()<{ token: string }[]>`select token from intake_forms`;
    const [m] = await messages("full_report_delivery");
    expect(m.subject).toBe("Welcome to the Growth plan: Maple Grove Dental");
    expect(m.body_text).toContain(`https://intheanswer.test/intake/${f.token}`);
    expect(m.body_text).toContain("Please do not put passwords in the form.");
    expect(m.attach_pdf).toBe(true);
  });

  it("Visibility: the first delivery is the full report, with no intake form", async () => {
    const { orderId } = await paidOrder("visibility");
    const r = await buildAndDeliverFullReport(orderId, deps);
    expect(r).toMatchObject({ built: true });
    const [m] = await messages("full_report_delivery");
    expect(m.subject).toBe("Welcome to the Visibility plan: Maple Grove Dental");
    expect(m.body_text).toContain("Welcome to the Visibility plan.");
    expect(m.body_text).toContain("arrange access to your website");
    expect(m.body_text).not.toContain("/intake/");
  });

  it("a report buyer who then starts a plan with the credit is not sent a second full report", async () => {
    const { clinicId, orderId } = await paidOrder("report");
    const sql = db();
    const first = await buildAndDeliverFullReport(orderId, deps);
    expect(first).toMatchObject({ built: true });
    await post(event("checkout.session.completed", session("cs_plan", clinicId, "visibility", { subscription: "sub_test_2", metadata: { clinic_id: clinicId, plan: "visibility", credit_order_id: orderId }, total_details: { amount_tax: 0, amount_discount: 20000 }, amount_total: 0 })));
    const [plan] = await sql<{ id: string; credit_order_id: string; credit_cents: number }[]>`select id, credit_order_id, credit_cents from orders where kind = 'subscription'`;
    expect(plan).toMatchObject({ credit_order_id: orderId, credit_cents: 20000 });
    const again = await buildAndDeliverFullReport(plan.id, deps);
    expect(again).toMatchObject({ built: false, reportId: first.reportId });
    expect(await sql`select 1 from reports where kind = 'full'`).toHaveLength(1);
    const welcome = (await messages("full_report_delivery")).find((m) => m.subject.startsWith("Welcome"));
    expect(welcome?.body_text).toContain("the one you already have");
  });
});
