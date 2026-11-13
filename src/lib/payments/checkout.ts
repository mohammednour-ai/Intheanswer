import { db } from "../db";
import { env } from "../env";
import { localDate } from "../time";
import { queueOwnerMail } from "../sending/outbox";
import {
  checkoutState, minTermText, orderKind, stripeClient, PLAN_NAMES, PLAN_PRICES, PRICE_CURRENCY,
  type CheckoutSessionParams, type Plan, type StripeLike,
} from "./stripe";

/**
 * Checkout for the three paid offers, reached from the buy buttons of a teaser.
 * The teaser token identifies the clinic; an old (superseded) teaser still works.
 */

export interface BuyTarget {
  reportId: string;
  clinicId: string;
  clinicName: string;
  email: string | null;       // prefilled at Stripe; never shown on our pages
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function isPlan(x: string): x is Plan {
  return x === "report" || x === "reports" || x === "monthly";
}

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
 * What the clinic already has, so nobody is charged twice. Both subscription
 * plans include the full report, so they also block the one-time purchase;
 * and a clinic holds one subscription at a time (moving from monthly reports
 * to the full service is arranged by email, so the first is ended properly).
 */
export async function alreadyPurchased(clinicId: string, plan: Plan): Promise<Plan | null> {
  const sql = db();
  const [sub] = await sql<{ plan: string }[]>`
    select plan from subscriptions where clinic_id = ${clinicId} and status in ${sql(LIVE_SUBSCRIPTION)}
    order by (plan = 'monthly') desc limit 1`;
  if (sub) return sub.plan === "reports" ? "reports" : "monthly";
  if (plan === "report") {
    const [o] = await sql`
      select 1 from orders where clinic_id = ${clinicId} and kind = 'one_time' and status in ('paid', 'partially_refunded') limit 1`;
    if (o) return "report";
  }
  return null;
}

export type StartResult =
  | { kind: "redirect"; url: string; sessionId: string }
  | { kind: "not_found" }
  | { kind: "closed"; reason: string }
  | { kind: "already"; has: Plan }
  | { kind: "busy" };

const MAX_SESSIONS_PER_HOUR = 6;

/** Create the Stripe Checkout Session and the pending order. Charges nothing itself. */
export async function startCheckout(token: string, plan: Plan, deps: { stripe?: StripeLike } = {}): Promise<StartResult> {
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

  // Every configured price must be what is published for this plan.
  const want = PLAN_PRICES[plan];
  const refuse = async (priceId: string, expected: string, found: { unit_amount: number | null; currency: string; recurring: { interval: string; interval_count: number } | null; active: boolean }): Promise<StartResult> => {
    const reason = `Stripe price ${priceId} does not match the published ${plan} offer (${expected})`;
    await queueOwnerMail("owner_alert", `stripe-price:${priceId}:${localDate(new Date())}`, "Checkout refused: Stripe price does not match",
      `${reason}.\n\nFound: ${found.unit_amount} ${found.currency}, ${found.recurring ? `every ${found.recurring.interval_count} ${found.recurring.interval}` : "one time"}, active: ${found.active}.\nNothing was charged. Fix the price id in the environment.`);
    return { kind: "closed", reason };
  };
  const cur = PRICE_CURRENCY.toUpperCase();
  const price = await stripe.prices.retrieve(state.priceId);
  const subscription = plan !== "report";
  const recurringOk = subscription
    ? price.recurring?.interval === "month" && price.recurring.interval_count === 1
    : price.recurring == null;
  const amount = subscription ? want.monthly : want.oneTime;
  if (!price.active || price.currency !== PRICE_CURRENCY || price.unit_amount !== amount || !recurringOk) {
    return refuse(state.priceId, `${(amount ?? 0) / 100} ${cur}${subscription ? " per month" : " one time"}`, price);
  }
  if (want.firstExtra != null) {
    if (!state.firstExtraPriceId) return { kind: "closed", reason: "the first-month price id is not set" };
    const extra = await stripe.prices.retrieve(state.firstExtraPriceId);
    if (!extra.active || extra.currency !== PRICE_CURRENCY || extra.unit_amount !== want.firstExtra || extra.recurring != null) {
      return refuse(state.firstExtraPriceId, `${want.firstExtra / 100} ${cur} one time, added to the first month`, extra);
    }
  }

  const e = env();
  const base = `${e.APP_URL}/buy/${token}/${plan}`;
  const meta: Record<string, string> = { clinic_id: target.clinicId, report_id: target.reportId, plan };
  if (subscription && state.minTerm) meta.min_term_months = String(state.minTerm);
  const tax = e.STRIPE_TAX_RATE_ID ? { tax_rates: [e.STRIPE_TAX_RATE_ID] } : {};
  const params: CheckoutSessionParams = {
    mode: subscription ? "subscription" : "payment",
    line_items: [
      { price: state.priceId, quantity: 1, ...tax },
      // a one-time line on a subscription checkout is charged on the first invoice only
      ...(want.firstExtra != null && state.firstExtraPriceId ? [{ price: state.firstExtraPriceId, quantity: 1, ...tax }] : []),
    ],
    client_reference_id: target.clinicId,
    metadata: meta,
    success_url: `${base}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/cancel`,
  };
  if (target.email) params.customer_email = target.email;
  if (subscription) {
    params.subscription_data = { metadata: meta };
    params.custom_text = { submit: { message: `${PLAN_NAMES[plan]}. Minimum term ${minTermText(state.minTerm!)}. Renews each month until cancelled.` } };
  } else {
    params.customer_creation = "always";
    params.payment_intent_data = { metadata: meta };
  }
  const session = await stripe.checkout.sessions.create(params);
  if (!session.url) return { kind: "closed", reason: "Stripe returned no checkout URL" };
  await sql`
    insert into orders (clinic_id, kind, plan, stripe_checkout_session_id, currency, status, customer_email)
    values (${target.clinicId}, ${orderKind(plan)}, ${plan}, ${session.id}, ${PRICE_CURRENCY}, 'pending', ${target.email})
    on conflict (stripe_checkout_session_id) do nothing`;
  return { kind: "redirect", url: session.url, sessionId: session.id };
}
