/**
 * Create, once, the Stripe prices and the report-credit coupon the offer needs,
 * with the amounts taken from src/lib/offer.ts, and print the settings to add:
 *
 *   npx tsx --env-file=.env.local scripts/stripe-setup.ts            test mode (an sk_test_ key)
 *   npx tsx --env-file=<file with the live key> scripts/stripe-setup.ts --live
 *   ... --new-only     leave the one-time report price alone (it already exists and is configured)
 *
 * Safe to run again: each price has a lookup key and the coupon a fixed id, so
 * what exists is found, not duplicated. A price whose amount no longer matches
 * the offer is reported, never changed (Stripe prices cannot be edited: make a
 * new one and archive the old). It refuses a live key without --live. Prints
 * ids only, never the key. Nothing is charged.
 */
import Stripe from "stripe";
import { REPORT_CREDIT, TIERS } from "../src/lib/offer";

const CURRENCY = "cad";
const live = process.argv.includes("--live");
const newOnly = process.argv.includes("--new-only");

interface Wanted { env: string; lookup: string; product: string; cents: number; monthly: boolean }
const PRICES: Wanted[] = [
  { env: "STRIPE_PRICE_ONE_TIME", lookup: "ita_report_one_time", product: `In The Answer: ${TIERS.report.name}`, cents: TIERS.report.oneTimeCents!, monthly: false },
  { env: "STRIPE_PRICE_VISIBILITY_MONTHLY", lookup: "ita_visibility_monthly", product: `In The Answer: ${TIERS.visibility.name}`, cents: TIERS.visibility.monthlyCents!, monthly: true },
  { env: "STRIPE_PRICE_GROWTH_MONTHLY", lookup: "ita_growth_monthly", product: `In The Answer: ${TIERS.growth.name}`, cents: TIERS.growth.monthlyCents!, monthly: true },
  { env: "STRIPE_PRICE_GROWTH_SETUP", lookup: "ita_growth_setup", product: `In The Answer: ${TIERS.growth.name} setup`, cents: TIERS.growth.setupCents!, monthly: false },
];
const COUPON_ID = `ita-report-credit-${REPORT_CREDIT.cents / 100}`;

async function main() {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  const isLive = key.startsWith("sk_live_") || key.startsWith("rk_live_");
  if (isLive && !live) throw new Error("this is a LIVE Stripe key: run again with --live if you mean it");
  if (!isLive && live) throw new Error("--live was given, but the key is a test key");
  const stripe = new Stripe(key);
  console.log(`Stripe ${isLive ? "LIVE" : "test"} mode\n`);

  const lines: string[] = [];
  let mismatch = false;
  for (const w of PRICES) {
    if (newOnly && w.env === "STRIPE_PRICE_ONE_TIME") continue;
    const current = process.env[w.env];
    // a price already configured is checked, not replaced
    let price: Stripe.Price | null = current ? await stripe.prices.retrieve(current).catch(() => null) : null;
    if (!price) price = (await stripe.prices.list({ lookup_keys: [w.lookup], active: true, limit: 1 })).data[0] ?? null;
    let note = "found";
    if (!price) {
      const product = await stripe.products.create({ name: w.product });
      price = await stripe.prices.create({
        product: product.id, currency: CURRENCY, unit_amount: w.cents, lookup_key: w.lookup,
        ...(w.monthly ? { recurring: { interval: "month" as const } } : {}),
      });
      note = "created";
    }
    const ok = price.active && price.currency === CURRENCY && price.unit_amount === w.cents
      && (w.monthly ? price.recurring?.interval === "month" && price.recurring.interval_count === 1 : price.recurring == null);
    if (!ok) mismatch = true;
    lines.push(`${w.env}=${price.id}`);
    console.log(`${ok ? "ok      " : "MISMATCH"} ${w.env} = ${price.id}  (${note}: ${(price.unit_amount ?? 0) / 100} ${price.currency.toUpperCase()}${price.recurring ? " a month" : ", one time"}; the offer says ${w.cents / 100})`);
  }

  let coupon: Stripe.Coupon | null = await stripe.coupons.retrieve(process.env.STRIPE_COUPON_REPORT_CREDIT || COUPON_ID).catch(() => null);
  let note = "found";
  if (!coupon) {
    coupon = await stripe.coupons.create({ id: COUPON_ID, name: "Full report credit", amount_off: REPORT_CREDIT.cents, currency: CURRENCY, duration: "once" });
    note = "created";
  }
  const couponOk = coupon.valid && coupon.amount_off === REPORT_CREDIT.cents && coupon.currency === CURRENCY && coupon.duration === "once";
  if (!couponOk) mismatch = true;
  lines.push(`STRIPE_COUPON_REPORT_CREDIT=${coupon.id}`);
  console.log(`${couponOk ? "ok      " : "MISMATCH"} STRIPE_COUPON_REPORT_CREDIT = ${coupon.id}  (${note}: ${(coupon.amount_off ?? 0) / 100} ${(coupon.currency ?? "").toUpperCase()} off, ${coupon.duration})`);

  console.log(`\nSettings for ${isLive ? "production (Vercel)" : ".env.local"}:\n${lines.join("\n")}`);
  if (mismatch) {
    console.log("\nSomething above does not match the offer. Checkout stays closed for that plan until it does.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
