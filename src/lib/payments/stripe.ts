import Stripe from "stripe";
import { env } from "../env";
import { effectiveDryRun } from "../settings";
import { ONLINE_TIERS, TIERS, isOnlineTier, type OnlineTier } from "../offer";

/**
 * The small part of the Stripe client this app uses. Code takes a `StripeLike`
 * so tests can pass a fake; nothing else in the app imports the `stripe` package.
 */
export interface CheckoutSessionParams {
  mode: "payment" | "subscription";
  line_items: { price: string; quantity: number; tax_rates?: string[] }[];
  client_reference_id: string;
  customer_email?: string;
  customer_creation?: "always";
  metadata: Record<string, string>;
  payment_intent_data?: { metadata: Record<string, string> };
  subscription_data?: { metadata: Record<string, string> };
  custom_text?: { submit?: { message: string } };
  /** The report credit. Never a code the buyer types: we attach it, for a clinic that qualifies. */
  discounts?: { coupon: string }[];
  success_url: string;
  cancel_url: string;
}

export interface StripeEventLike {
  id: string;
  type: string;
  created: number;
  livemode?: boolean;
  data: { object: Record<string, unknown> };
}

export interface StripeLike {
  checkout: { sessions: { create(params: CheckoutSessionParams): Promise<{ id: string; url: string | null }> } };
  prices: {
    retrieve(id: string): Promise<{ id: string; active: boolean; currency: string; unit_amount: number | null; recurring: { interval: string; interval_count: number } | null }>;
  };
  coupons: {
    retrieve(id: string): Promise<{ id: string; valid: boolean; amount_off: number | null; currency: string | null; duration: string }>;
  };
  webhooks: { constructEvent(payload: string, header: string, secret: string): StripeEventLike };
}

let client: StripeLike | null = null;
let override: StripeLike | null = null;

/** The real client, or null when STRIPE_SECRET_KEY is not set. */
export function stripeClient(): StripeLike | null {
  if (override) return override;
  const key = env().STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!client) client = new Stripe(key) as unknown as StripeLike;
  return client;
}

/** Tests: use a fake client everywhere (pass null to go back to the real one). */
export function setStripeForTests(fake: StripeLike | null) {
  override = fake;
  client = null;
}

/**
 * The plans a clinic can buy online. What they are, what they cost and their
 * terms are stated in src/lib/offer.ts and nowhere else; this file only knows
 * how to charge for them. Transformation is quoted by the founder and never
 * goes through checkout.
 */
export type Plan = OnlineTier;
export type SubscriptionPlan = Exclude<Plan, "report">;
export const PLANS: Plan[] = ONLINE_TIERS;
export const isPlan = (plan: string | null | undefined): plan is Plan => isOnlineTier(plan);
export const isSubscriptionPlan = (plan: string | null | undefined): plan is SubscriptionPlan => isOnlineTier(plan) && TIERS[plan].kind === "subscription";
export const orderKind = (plan: Plan) => TIERS[plan].kind;

export const PRICE_CURRENCY = "cad";

/** Minimum term of a plan in months (null: none), from the offer. */
export function minTermMonths(plan: Plan): number | null {
  return TIERS[plan].minTermMonths;
}

export function minTermText(n: number): string {
  return n === 1 ? "1 month" : `${n} months`;
}

export interface CheckoutState {
  open: boolean;
  reason: string | null;      // for the owner and the logs, never shown to the visitor
  priceId: string | null;
  setupPriceId: string | null; // one-time price added to the first invoice (the Growth setup)
  couponId: string | null;     // the report credit, attached only by us and only for a clinic that qualifies
  minTerm: number | null;
}

/**
 * Whether a checkout may be started for a plan. Closed in dry run and when
 * any Stripe setting the plan needs is missing (the webhook secret too:
 * without it a payment could never be fulfilled).
 */
export async function checkoutState(plan: Plan): Promise<CheckoutState> {
  const e = env();
  const t = TIERS[plan];
  const priceId = (plan === "growth" ? e.STRIPE_PRICE_GROWTH_MONTHLY : plan === "visibility" ? e.STRIPE_PRICE_VISIBILITY_MONTHLY : e.STRIPE_PRICE_ONE_TIME) ?? null;
  const setupPriceId = t.setupCents ? (e.STRIPE_PRICE_GROWTH_SETUP ?? null) : null;
  const couponId = t.kind === "subscription" ? (e.STRIPE_COUPON_REPORT_CREDIT ?? null) : null;
  const minTerm = t.minTermMonths;
  const closed = (reason: string): CheckoutState => ({ open: false, reason, priceId, setupPriceId, couponId, minTerm });
  if (await effectiveDryRun()) return closed("dry run");
  if (!stripeClient()) return closed("STRIPE_SECRET_KEY is not set");
  if (!e.STRIPE_WEBHOOK_SECRET) return closed("STRIPE_WEBHOOK_SECRET is not set");
  if (!priceId) return closed(`the price id for the ${plan} plan is not set`);
  if (t.setupCents && !setupPriceId) return closed("STRIPE_PRICE_GROWTH_SETUP is not set");
  return { open: true, reason: null, priceId, setupPriceId, couponId, minTerm };
}
