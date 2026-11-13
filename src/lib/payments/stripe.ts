import Stripe from "stripe";
import { env, OWNER_PLACEHOLDER_RE } from "../env";
import { effectiveDryRun } from "../settings";

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
 * The three paid plans:
 * - report:  the full report and fix files, one payment
 * - reports: a new full report every month, nothing installed by us
 * - monthly: the full service (website work, fixes installed, monthly retest)
 */
export type Plan = "report" | "reports" | "monthly";
export type SubscriptionPlan = "reports" | "monthly";
export const PLANS: Plan[] = ["report", "reports", "monthly"];
export const isSubscriptionPlan = (plan: string | null | undefined): plan is SubscriptionPlan => plan === "reports" || plan === "monthly";
export const orderKind = (plan: Plan) => (plan === "report" ? "one_time" : "subscription");

export const PRICE_CURRENCY = "cad";

/**
 * Published prices in cents, before HST. Every Stripe price is checked against
 * these before a checkout is created. `firstExtra` is a one-time amount added
 * to the first month only (monthly reports: 100 + 50 = 150 for the first month).
 */
export const PLAN_PRICES: Record<Plan, { oneTime: number | null; monthly: number | null; firstExtra: number | null }> = {
  report: { oneTime: 20000, monthly: null, firstExtra: null },
  reports: { oneTime: null, monthly: 5000, firstExtra: 10000 },
  monthly: { oneTime: null, monthly: 20000, firstExtra: null },
};

export const PLAN_NAMES: Record<Plan, string> = {
  report: "Full report and fix files",
  reports: "Monthly reports",
  monthly: "Full service plan",
};

/** What the first payment comes to, before HST. */
export function firstPaymentCents(plan: Plan): number {
  const p = PLAN_PRICES[plan];
  return (p.oneTime ?? 0) + (p.monthly ?? 0) + (p.firstExtra ?? 0);
}

/**
 * Minimum term of a subscription plan in months: MONTHLY_MIN_TERM_MONTHS for
 * the full service plan, REPORTS_MIN_TERM_MONTHS for monthly reports ("3" or
 * "3 months"). Null while it is still a placeholder or not a number.
 */
export function minTermMonths(plan: SubscriptionPlan = "monthly"): number | null {
  const raw = (plan === "reports" ? env().REPORTS_MIN_TERM_MONTHS : env().MONTHLY_MIN_TERM_MONTHS).trim();
  if (OWNER_PLACEHOLDER_RE.test(raw)) return null;
  const m = raw.match(/^(\d{1,2})(\s*months?)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 36 ? n : null;
}

export function minTermText(n: number): string {
  return n === 1 ? "1 month" : `${n} months`;
}

export interface CheckoutState {
  open: boolean;
  reason: string | null;      // for the owner and the logs, never shown to the visitor
  priceId: string | null;
  firstExtraPriceId: string | null; // one-time price added to the first month (monthly reports only)
  minTerm: number | null;
}

/**
 * Whether a checkout may be started for a plan. Closed in dry run, when any
 * Stripe setting is missing (the webhook secret too: without it a payment
 * could never be fulfilled), and for the full service plan while the minimum term
 * is not set.
 */
export async function checkoutState(plan: Plan): Promise<CheckoutState> {
  const e = env();
  const priceId = (plan === "monthly" ? e.STRIPE_PRICE_MONTHLY : plan === "reports" ? e.STRIPE_PRICE_REPORTS_MONTHLY : e.STRIPE_PRICE_ONE_TIME) ?? null;
  const firstExtraPriceId = plan === "reports" ? (e.STRIPE_PRICE_REPORTS_FIRST ?? null) : null;
  const minTerm = plan === "report" ? null : minTermMonths(plan);
  const closed = (reason: string): CheckoutState => ({ open: false, reason, priceId, firstExtraPriceId, minTerm });
  if (await effectiveDryRun()) return closed("dry run");
  if (!stripeClient()) return closed("STRIPE_SECRET_KEY is not set");
  if (!e.STRIPE_WEBHOOK_SECRET) return closed("STRIPE_WEBHOOK_SECRET is not set");
  if (!priceId) return closed(`the price id for the ${plan} plan is not set`);
  if (plan === "reports" && !firstExtraPriceId) return closed("STRIPE_PRICE_REPORTS_FIRST is not set");
  if (plan !== "report" && minTerm == null) {
    return closed(`${plan === "reports" ? "REPORTS_MIN_TERM_MONTHS" : "MONTHLY_MIN_TERM_MONTHS"} is not set to a number of months`);
  }
  return { open: true, reason: null, priceId, firstExtraPriceId, minTerm };
}
