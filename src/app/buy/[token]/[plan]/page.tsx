import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ownerDetails } from "@/lib/env";
import { alreadyPurchased, isPlan, resolveBuyToken, startCheckout } from "@/lib/payments/checkout";
import { checkoutState, minTermText, PLAN_NAMES, PLAN_PRICES, firstPaymentCents } from "@/lib/payments/stripe";
import { Shell } from "../../Shell";

export const metadata: Metadata = { title: "Checkout", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Runs only on the button press, so a mail scanner that opens the link never creates a checkout. */
async function go(token: string, plan: string) {
  "use server";
  if (!isPlan(plan)) notFound();
  const r = await startCheckout(token, plan);
  if (r.kind === "redirect") redirect(r.url);
  if (r.kind === "not_found") notFound();
  // closed / already purchased / too many tries: the page itself explains
  redirect(`/buy/${token}/${plan}${r.kind === "busy" ? "?e=busy" : ""}`);
}

const cad = (cents: number) => `${cents / 100} CAD`;

export default async function BuyPage(props: PageProps<"/buy/[token]/[plan]">) {
  const { token, plan } = await props.params;
  const sp = await props.searchParams;
  if (!isPlan(plan)) notFound();
  const target = await resolveBuyToken(token);
  if (!target) notFound();
  const o = ownerDetails();
  const contact = <a href={`mailto:${o.email}`}>{o.email}</a>;

  const has = await alreadyPurchased(target.clinicId, plan);
  if (has) {
    const onPlan = has !== "report";
    return (
      <Shell>
        <h1 style={{ marginTop: 24 }}>{onPlan ? `You are already on ${has === "monthly" ? "the full service plan" : "monthly reports"}` : "You already have the full report"}</h1>
        <p>
          {onPlan
            ? `${target.clinicName} is on ${has === "monthly" ? "the full service plan" : "monthly reports"}${plan === "report" ? ", which includes the full report" : ""}. Nothing more needs to be paid.`
            : `The full report for ${target.clinicName} is already paid for. Nothing was charged again.`}
        </p>
        {has === "reports" && plan === "monthly" && (
          <p>To move from monthly reports to the full service plan, write to {contact} and we will switch you over without charging twice.</p>
        )}
        <p>If an email from us has not arrived, or this looks wrong, write to {contact}.</p>
        {has === "report" && plan === "report" && (
          <p><Link href={`/buy/${token}/reports`}>See monthly reports</Link> · <Link href={`/buy/${token}/monthly`}>See the full service plan</Link></p>
        )}
      </Shell>
    );
  }

  const state = await checkoutState(plan);
  if (!state.open) {
    return (
      <Shell>
        <h1 style={{ marginTop: 24 }}>Checkout is not open yet</h1>
        <p>We are not taking payments online at the moment. Nothing was charged.</p>
        <p>To order for {target.clinicName}, or to ask a question, write to {contact}.</p>
        <p><Link href={`/r/${token}`}>Back to your report</Link></p>
      </Shell>
    );
  }

  const prices = PLAN_PRICES[plan];
  const others = (["report", "reports", "monthly"] as const).filter((p) => p !== plan);
  const otherLabel = { report: "One-time report", reports: "Monthly reports", monthly: "Full service plan" } as const;
  return (
    <Shell>
      <h1 style={{ marginTop: 24 }}>{PLAN_NAMES[plan]}</h1>
      <p className="muted">For {target.clinicName}</p>
      {sp.e === "busy" && <p className="pill pill-warn" role="alert">Too many tries in the last hour. Please try again later.</p>}
      <section className="card stack" style={{ marginTop: 16 }}>
        <p style={{ fontSize: "1.4rem", fontWeight: 700, margin: 0 }}>
          {plan === "report" && <>{cad(prices.oneTime!)} one time</>}
          {plan === "reports" && <>{cad(firstPaymentCents(plan))} for the first month, then {cad(prices.monthly!)} per month</>}
          {plan === "monthly" && <>{cad(prices.monthly!)} per month</>}
          {" "}<span className="small muted" style={{ fontWeight: 500 }}>plus HST</span>
        </p>
        {plan === "report" && (
          <ul>
            <li>One payment by card. No contract.</li>
            <li>Every finding with what we saw and the fix, and the fix files for your web person.</li>
            <li>One retest four weeks later, with a second report showing what changed.</li>
            <li>The report is checked before it is sent to the email address you give at payment.</li>
            <li>Refunds are given when the report has not yet been delivered. To ask for one, write to us from the address you paid with.</li>
          </ul>
        )}
        {plan === "reports" && (
          <ul>
            <li>Billed each month by card: {cad(firstPaymentCents(plan))} today, then {cad(prices.monthly!)} each month.</li>
            <li><strong>Minimum term: {minTermText(state.minTerm!)}.</strong></li>
            <li><strong>The plan renews each month until it is cancelled.</strong></li>
            <li>The full report and fix files first, then an updated report every month after a fresh retest.</li>
            <li>The changes on your website are made by your own web person. To have us make them, choose the full service plan.</li>
            <li>To cancel, write to us from the address you paid with.</li>
          </ul>
        )}
        {plan === "monthly" && (
          <ul>
            <li>Billed each month by card.</li>
            <li><strong>Contract term: {minTermText(state.minTerm!)}.</strong></li>
            <li><strong>The plan renews each month until it is cancelled.</strong></li>
            <li>We renovate your website, or take it over and run it, and install every fix. The domain name and the content stay yours.</li>
            <li>You get the full report first, then a short form about your website so we can begin the work.</li>
            <li>To cancel, write to us from the address you paid with.</li>
          </ul>
        )}
        <p className="small muted">
          What is included is described on the <Link href="/pricing">pricing page</Link>. No one can guarantee what an AI assistant will say; we report what it said and fix what we can see.
        </p>
        <form action={go.bind(null, token, plan)}>
          <button className="btn btn-primary">Continue to payment</button>
        </form>
        <p className="small muted">Payment is taken by Stripe. We never see your card number.</p>
      </section>
      <p style={{ marginTop: 16 }}>
        <Link href={`/r/${token}`}>Back to your report</Link>
        {others.map((p) => <span key={p}> · <Link href={`/buy/${token}/${p}`}>{otherLabel[p]}</Link></span>)}
      </p>
    </Shell>
  );
}
