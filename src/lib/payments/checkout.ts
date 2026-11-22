import { db } from "../db";
import { env } from "../env";
import { localDate } from "../time";
import { queueOwnerMail } from "../sending/outbox";
import { REPORT_CREDIT, TIERS, cad, firstPaymentCents } from "../offer";
import {
  checkoutState, isPlan, minTermText, orderKind, stripeClient, PRICE_CURRENCY,
  type CheckoutSessionParams, type Plan, type StripeLike,
} from "./stripe";

/**
 * Checkout for the plans bought online, reached from the buy buttons of a
 * teaser. The teaser token identifies the clinic; an old (superseded) teaser
 * still works. What each plan costs comes from src/lib/offer.ts.
 */

export { isPlan };

export interface BuyTarget {
  reportId: string;
  clinicId: string;
  clinicName: string;
  email: string | null;       // prefilled at Stripe; never shown on our pages
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** The clinic behind a teaser token. Samples and unverified drafts do not count. */
export async function resolveBuyToken(token: string): Promise<BuyTarget | null> {
  if (!TOKEN_RE.test(token)) return null;
  const sql = db();
  const [r] = await sql<{ id: string; clinic_id: string; name: string }[]>`
    select r.id, r.clinic_id, coalesce(c.site_name, c.name) as name
    from reports r join clinics c on c.id = r.clinic_id
    where r.token = ${token} and r.kind = 'teaser' and r.data->>'verified' = 'true'`;
  if (!r) return null;
  const [contact] = await sql<{ email: string }[]>`
    select email from contacts where clinic_id = ${r.clinic_id} and is_primary order by found_at limit 1`;
  let email = contact?.email ?? null;
  if (!email) {
    // self-serve clinics have no published contact row: use the address the teaser went to
    const [m] = await sql<{ to_email: string }[]>`
      select to_email from messages where report_id = ${r.id} and type in ('first_email', 'self_serve_teaser')
      order by created_at desc limit 1`;
    email = m?.to_email ?? null;
  }
  return { reportId: r.id, clinicId: r.clinic_id, clinicName: r.name, email };
}

/** Subscription states that still mean "this clinic is on a subscription plan". */
export const LIVE_SUBSCRIPTION = ["active", "trialing", "past_due", "unpaid", "incomplete"];

/**
 * What the clinic already has, so nobody is charged twice: the plan as it is
 * stored (a current key, or a retired one such as "monthly"). Every monthly
 * plan includes the full report, so a subscription also blocks the one-time
 * purchase; and a clinic holds one subscription at a time (moving to a larger
 * plan is arranged by email, so the first is ended properly). A subscription
 * whose plan we cannot name is treated as the largest: nothing more is sold
 * to it online.
 */
export async function alreadyPurchased(clinicId: string, plan: Plan): Promise<string | null> {
  const sql = db();
  const [sub] = await sql<{ plan: string | null }[]>`
    select plan from subscriptions where clinic_id = ${clinicId} and status in ${sql(LIVE_SUBSCRIPTION)}
    order by created_at desc limit 1`;
  if (sub) return sub.plan ?? "transformation";
  if (plan === "report") {
    const [o] = await sql`
      select 1 from orders where clinic_id = ${clinicId} and kind = 'one_time' and status in ('paid', 'partially_refunded') limit 1`;
    if (o) return "report";
  }
  return null;
}

export interface ReportCredit {
  /** The paid report order whose price is credited. */
  orderId: string;
  cents: number;
}

/**
 * The report credit a clinic qualifies for right now: it paid for the full
 * report within the last 30 days, the payment was not refunded, and the
 * credit has not been used by another paid order.
 */
export async function reportCredit(clinicId: string, now = new Date()): Promise<ReportCredit | null> {
  const since = new Date(now.getTime() - REPORT_CREDIT.days * 86400e3);
  const [o] = await db()<{ id: string }[]>`
    select o.id from orders o
    where o.clinic_id = ${clinicId} and o.kind = 'one_time' and o.status = 'paid' and o.paid_at > ${since}
      and not exists (select 1 from orders u where u.credit_order_id = o.id and u.status in ('paid', 'partially_refunded'))
    order by o.paid_at desc limit 1`;
  return o ? { orderId: o.id, cents: REPORT_CREDIT.cents } : null;
}

/** What a clinic would pay at checkout today for a plan, before HST, and the credit inside it. */
export async function dueToday(clinicId: string, plan: Plan, now = new Date()): Promise<{ cents: number; credit: ReportCredit | null }> {
  const credit = TIERS[plan].kind === "subscription" ? await reportCredit(clinicId, now) : null;
  return { cents: firstPaymentCents(plan, credit?.cents ?? 0), credit };
}

export type StartResult =
  | { kind: "redirect"; url: string; sessionId: string }
  | { kind: "not_found" }
  | { kind: "closed"; reason: string }
  | { kind: "already"; has: string }
  /** The amount the page showed is no longer the amount due (a credit ran out or was used): show the page again. */
  | { kind: "changed" }
  | { kind: "busy" };

const MAX_SESSIONS_PER_HOUR = 6;

/**
 * Create the Stripe Checkout Session and the pending order. Charges nothing
 * itself. `expectCents` is the first payment the buy page showed: if it is no
 * longer what is due, nothing is created.
 */
export async function startCheckout(token: string, plan: Plan, deps: { stripe?: StripeLike; expectCents?: number; now?: Date } = {}): Promise<StartResult> {
  const target = await resolveBuyToken(token);
  if (!target) return { kind: "not_found" };
  const has = await alreadyPurchased(target.clinicId, plan);
  if (has) return { kind: "already", has };
  const state = await checkoutState(plan);
  if (!state.open || !state.priceId) return { kind: "closed", reason: state.reason ?? "closed" };
  const stripe = deps.stripe ?? stripeClient();
  if (!stripe) return { kind: "closed", reason: "no Stripe client" };

  const sql = db();
  const [recent] = await sql<{ n: number }[]>`
    select count(*)::int as n from orders where clinic_id = ${target.clinicId} and created_at > now() - interval '1 hour'`;
  if (recent.n >= MAX_SESSIONS_PER_HOUR) return { kind: "busy" };

  const tier = TIERS[plan];
  const subscription = tier.kind === "subscription";
  const { cents: due, credit } = await dueToday(target.clinicId, plan, deps.now);
  if (deps.expectCents != null && deps.expectCents !== due) return { kind: "changed" };

  // Everything configured in Stripe must be what is published for this plan.
  const refuse = async (what: string, id: string, expected: string, found: string): Promise<StartResult> => {
    const reason = `Stripe ${what} ${id} does not match the published ${plan} offer (${expected})`;
    await queueOwnerMail("owner_alert", `stripe-price:${id}:${localDate(new Date())}`, `Checkout refused: Stripe ${what} does not match`,
      `${reason}.\n\nFound: ${found}.\nNothing was charged. Fix the ${what} id in the environment.`);
    return { kind: "closed", reason };
  };
  const describe = (p: { unit_amount: number | null; currency: string; recurring: { interval: string; interval_count: number } | null; active: boolean }) =>
    `${p.unit_amount} ${p.currency}, ${p.recurring ? `every ${p.recurring.interval_count} ${p.recurring.interval}` : "one time"}, active: ${p.active}`;
  const price = await stripe.prices.retrieve(state.priceId);
  const recurringOk = subscription
    ? price.recurring?.interval === "month" && price.recurring.interval_count === 1
    : price.recurring == null;
  const amount = subscription ? tier.monthlyCents : tier.oneTimeCents;
  if (!price.active || price.currency !== PRICE_CURRENCY || price.unit_amount !== amount || !recurringOk) {
    return refuse("price", state.priceId, `${cad(amount)}${subscription ? " per month" : " one time"}`, describe(price));
  }
  if (tier.setupCents != null) {
    if (!state.setupPriceId) return { kind: "closed", reason: "the setup price id is not set" };
    const setup = await stripe.prices.retrieve(state.setupPriceId);
    if (!setup.active || setup.currency !== PRICE_CURRENCY || setup.unit_amount !== tier.setupCents || setup.recurring != null) {
      return refuse("price", state.setupPriceId, `${cad(tier.setupCents)} one time, the setup added to the first invoice`, describe(setup));
    }
  }
  if (credit) {
    // The credit is published: a clinic that qualifies is never charged the full amount because a setting is missing.
    if (!state.couponId) {
      const reason = "STRIPE_COUPON_REPORT_CREDIT is not set, and this clinic qualifies for the report credit";
      await queueOwnerMail("owner_alert", `stripe-coupon-missing:${localDate(new Date())}`, "Checkout refused: the report credit is not set up",
        `${target.clinicName} bought the full report within ${REPORT_CREDIT.days} days and tried to start ${tier.inSentence}, but ${reason}.\nNothing was charged. Create the coupon in Stripe (${cad(credit.cents)} off, once) and set its id.`);
      return { kind: "closed", reason };
    }
    const coupon = await stripe.coupons.retrieve(state.couponId);
    if (!coupon.valid || coupon.amount_off !== credit.cents || coupon.currency !== PRICE_CURRENCY || coupon.duration !== "once") {
      return refuse("coupon", state.couponId, `${cad(credit.cents)} off, once`, `${coupon.amount_off} ${coupon.currency}, duration ${coupon.duration}, valid: ${coupon.valid}`);
    }
  }

  const e = env();
  const base = `${e.APP_URL}/buy/${token}/${plan}`;
  const meta: Record<string, string> = { clinic_id: target.clinicId, report_id: target.reportId, plan };
  if (subscription && state.minTerm) meta.min_term_months = String(state.minTerm);
  if (credit) meta.credit_order_id = credit.orderId;
  const tax = e.STRIPE_TAX_RATE_ID ? { tax_rates: [e.STRIPE_TAX_RATE_ID] } : {};
  const params: CheckoutSessionParams = {
    mode: subscription ? "subscription" : "payment",
    line_items: [
      { price: state.priceId, quantity: 1, ...tax },
      // a one-time line on a subscription checkout is charged on the first invoice only
      ...(tier.setupCents != null && state.setupPriceId ? [{ price: state.setupPriceId, quantity: 1, ...tax }] : []),
    ],
    client_reference_id: target.clinicId,
    metadata: meta,
    success_url: `${base}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/cancel`,
  };
  if (target.email) params.customer_email = target.email;
  if (credit && state.couponId) params.discounts = [{ coupon: state.couponId }];
  if (subscription) {
    params.subscription_data = { metadata: meta };
    const term = state.minTerm ? `Minimum term ${minTermText(state.minTerm)}, then month to month.` : "Month to month.";
    params.custom_text = { submit: { message: `${tier.name}. ${term} Renews each month until cancelled.` } };
  } else {
    params.customer_creation = "always";
    params.payment_intent_data = { metadata: meta };
  }
  const session = await stripe.checkout.sessions.create(params);
  if (!session.url) return { kind: "closed", reason: "Stripe returned no checkout URL" };
  await sql`
    insert into orders (clinic_id, kind, plan, stripe_checkout_session_id, currency, status, customer_email, credit_cents, credit_order_id)
    values (${target.clinicId}, ${orderKind(plan)}, ${plan}, ${session.id}, ${PRICE_CURRENCY}, 'pending', ${target.email},
            ${credit?.cents ?? 0}, ${credit?.orderId ?? null})
    on conflict (stripe_checkout_session_id) do nothing`;
  return { kind: "redirect", url: session.url, sessionId: session.id };
}

// ---------------------------------------------------------------------------
// The plan that is quoted, not bought
// ---------------------------------------------------------------------------

export type QuoteResult = { ok: true } | { ok: false; reason: "not_found" | "busy" };

const MAX_QUOTE_REQUESTS_PER_DAY = 3;

/**
 * A clinic asks for a quote (the Transformation plan, which is never bought
 * online). No payment and no Stripe: the owner gets a task and an alert, and
 * calls the clinic. One open request per clinic; asking again adds nothing.
 */
export async function requestQuote(token: string, input: { phone?: string; bestTime?: string; note?: string }): Promise<QuoteResult> {
  const target = await resolveBuyToken(token);
  if (!target) return { ok: false, reason: "not_found" };
  const sql = db();
  const [recent] = await sql<{ n: number }[]>`
    select count(*)::int as n from owner_tasks where clinic_id = ${target.clinicId} and kind = 'quote_request' and created_at > now() - interval '1 day'`;
  if (recent.n >= MAX_QUOTE_REQUESTS_PER_DAY) return { ok: false, reason: "busy" };
  const clean = (v: string | undefined, max: number) => (v ?? "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const phone = clean(input.phone, 40), bestTime = clean(input.bestTime, 120), note = clean(input.note, 600);
  const body = [
    `${target.clinicName} asked for a quote for ${TIERS.transformation.inSentence} on the page its report links to.`,
    phone ? `Phone: ${phone}` : "No phone number given.",
    bestTime ? `Best time: ${bestTime}` : "",
    note ? `What they wrote: ${note}` : "",
    target.email ? `Email on file: ${target.email}` : "",
    `Clinic: ${env().APP_URL}/portal/clinic/${target.clinicId}`,
  ].filter(Boolean).join("\n");
  const title = `Quote request: ${target.clinicName} (${TIERS.transformation.name})`;
  const made = await sql`
    insert into owner_tasks (kind, clinic_id, title, body)
    select 'quote_request', ${target.clinicId}, ${title}, ${body}
    where not exists (select 1 from owner_tasks where clinic_id = ${target.clinicId} and kind = 'quote_request' and status = 'open')
    returning id`;
  if (made.length) await queueOwnerMail("owner_alert", `quote:${target.clinicId}:${localDate(new Date())}`, title, body);
  return { ok: true };
}
