import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ownerDetails } from "@/lib/env";
import { alreadyPurchased, isPlan, resolveBuyToken, startCheckout } from "@/lib/payments/checkout";
import { checkoutState, minTermText, PLAN_NAMES, PLAN_PRICES, firstPaymentCents } from "@/lib/payments/stripe";
import { Shell } from "../../Shell";
import site from "../../../(site)/site.module.css";
import s from "../../buy.module.css";

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

const ARROW = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
);

/** Twelve cells, the first `months` filled: how long the plan commits you. */
function Meter({ months }: { months: number }) {
  return (
    <span className={s.meter} aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => <span key={i} className={i < months ? s.on : undefined} />)}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className={s.row}>
      <span className={s.rowLabel}>{label}</span>
      <span className={s.rowValue}>{children}</span>
    </li>
  );
}

/** Numbered steps joined by a rail; the first (paying) is the one in blue. */
function Steps({ steps }: { steps: [string, string][] }) {
  return (
    <ol className={s.steps}>
      {steps.map(([title, body], i) => (
        <li key={title} className={s.step}>
          <span className={s.rail} aria-hidden="true">
            <span className={`${s.dot}${i === 0 ? ` ${s.dotOn}` : ""}`}>{i + 1}</span>
            {i < steps.length - 1 && <span className={s.line} />}
          </span>
          <span className={s.stepText}>
            <span className={s.stepTitle}>{title}</span>
            <span className={s.stepBody}>{body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

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
        <h1>{onPlan ?`You are already on ${has === "monthly" ? "the full service plan" : "monthly reports"}` : "You already have the full report"}</h1>
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
        <h1>Checkout is not open yet</h1>
        <p>We are not taking payments online at the moment. Nothing was charged.</p>
        <p>To order for {target.clinicName}, or to ask a question, write to {contact}.</p>
        <p><Link href={`/r/${token}`}>Back to your report</Link></p>
      </Shell>
    );
  }

  const prices = PLAN_PRICES[plan];
  const others = (["report", "reports", "monthly"] as const).filter((p) => p !== plan);
  const otherLabel = { report: "One-time report", reports: "Monthly reports", monthly: "Full service plan" } as const;
  const contract = `${o.contractTerm} contract`;
  // one line per option, the same three facts as the plan cards: price, who installs, how long you commit
  const otherSummary = {
    report: `${cad(PLAN_PRICES.report.oneTime!)} one time · Your web person installs · No contract`,
    reports: `${cad(firstPaymentCents("reports"))} first month, then ${cad(PLAN_PRICES.reports.monthly!)} per month · Your web person installs · Minimum term ${o.reportsMinTerm}`,
    monthly: `${cad(PLAN_PRICES.monthly.monthly!)} per month · We do the work for you · ${contract[0].toUpperCase() + contract.slice(1)}`,
  } as const;
  const steps: Record<typeof plan, [string, string][]> = {
    report: [
      ["You pay", "By card, through Stripe. One payment."],
      ["The report is checked", "Before it is sent to the email address you give at payment."],
      ["The full report", "Every finding with the fix, and the fix files for your web person."],
      ["One retest", "Four weeks later, with a second report showing what changed."],
    ],
    reports: [
      ["You pay", "By card, through Stripe. Billed each month."],
      ["The full report", "With the fix files, checked before it is sent."],
      ["Every month", "A fresh retest and an updated report."],
    ],
    monthly: [
      ["You pay", "By card, through Stripe. Billed each month."],
      ["The full report", "You get the full report first."],
      ["A short form about your website", "So we can begin the work."],
      ["The work begins", "We renovate your website, or take it over and run it, and install every fix."],
    ],
  };
  return (
    <Shell wide>
      <div className={s.intro}>
        <Link className={s.back} href={`/r/${token}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5" /><path d="M11 6l-6 6 6 6" /></svg>
          Back to your report
        </Link>
        <span className={site.eyebrow}>Checkout</span>
        <h1 className={s.h1}>{PLAN_NAMES[plan]}</h1>
        <p className={s.for}>For {target.clinicName}</p>
      </div>
      {sp.e === "busy" && <p className={`${s.notice} ${s.noticeWarn}`} role="alert">Too many tries in the last hour. Please try again later.</p>}
      <div className={s.layout}>
        <section className={s.terms} aria-labelledby="terms-h">
          <h2 id="terms-h" className={s.label}>What you are buying</h2>
          <p className={s.priceLine}>
            {plan === "report" && <><span className={s.price}>{cad(prices.oneTime!)}</span><span><span className={s.per}>one time</span> <span className={s.hst}>plus HST</span></span></>}
            {plan === "reports" && <><span className={s.price}>{cad(firstPaymentCents(plan))}</span><span><span className={s.per}>for the first month, then {cad(prices.monthly!)} per month</span> <span className={s.hst}>plus HST</span></span></>}
            {plan === "monthly" && <><span className={s.price}>{cad(prices.monthly!)}</span><span><span className={s.per}>per month</span> <span className={s.hst}>plus HST</span></span></>}
          </p>
          {plan === "report" && (
            <ul className={s.rows}>
              <Row label="Who does the work"><span className={s.big}>Your web person</span></Row>
              <Row label="Billing">One payment by card. No contract.</Row>
              <Row label="What you get">Every finding with what we saw and the fix, and the fix files for your web person.</Row>
              <Row label="Retest">One retest four weeks later, with a second report showing what changed.</Row>
              <Row label="Delivery">The report is checked before it is sent to the email address you give at payment.</Row>
              <Row label="Refunds">Refunds are given when the report has not yet been delivered. To ask for one, write to us from the address you paid with.</Row>
            </ul>
          )}
          {plan === "reports" && (
            <ul className={s.rows}>
              <Row label="Who does the work"><span className={s.big}>Your web person</span><span>The changes on your website are made by your own web person. To have us make them, choose the full service plan.</span></Row>
              <Row label="Billing">Billed each month by card: {cad(firstPaymentCents(plan))} today, then {cad(prices.monthly!)} each month.</Row>
              <Row label="Minimum term"><strong className={s.big}>{minTermText(state.minTerm!)}</strong><Meter months={state.minTerm ?? 0} /></Row>
              <Row label="Renewal"><strong className={s.rowStrong}>The plan renews each month until it is cancelled.</strong></Row>
              <Row label="What you get">The full report and fix files first, then an updated report every month after a fresh retest.</Row>
              <Row label="To cancel">To cancel, write to us from the address you paid with.</Row>
            </ul>
          )}
          {plan === "monthly" && (
            <ul className={s.rows}>
              <Row label="Who does the work"><span className={s.weDo}>We do the work for you</span></Row>
              <Row label="Billing">Billed each month by card.</Row>
              <Row label="Contract term"><strong className={s.big}>{minTermText(state.minTerm!)}</strong><Meter months={state.minTerm ?? 0} /></Row>
              <Row label="Renewal"><strong className={s.rowStrong}>The plan renews each month until it is cancelled.</strong></Row>
              <Row label="What we do">We renovate your website, or take it over and run it, and install every fix. The domain name and the content stay yours.</Row>
              <Row label="After you pay">You get the full report first, then a short form about your website so we can begin the work.</Row>
              <Row label="To cancel">To cancel, write to us from the address you paid with.</Row>
            </ul>
          )}
          <p className={s.fine}>
            What is included is described on the <Link href="/pricing">pricing page</Link>. No one can guarantee what an AI assistant will say; we report what it said and fix what we can see.
          </p>
          <form action={go.bind(null, token, plan)} className={s.form}>
            <button className={s.pay}>Continue to payment{ARROW}</button>
            <p className={s.stripe}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
              Payment is taken by Stripe. We never see your card number.
            </p>
          </form>
        </section>

        <div className={s.aside}>
          <section className={s.next} aria-labelledby="next-h">
            <h2 id="next-h" className={s.h2}>What happens next</h2>
            <Steps steps={steps[plan]} />
          </section>
          <section className={s.other} aria-labelledby="other-h">
            <h2 id="other-h" className={s.label}>The other two options</h2>
            <ul className={s.otherList}>
              {others.map((p) => (
                <li key={p}>
                  <Link className={s.otherLink} href={`/buy/${token}/${p}`}>
                    <span className={s.otherText}>
                      <span className={s.otherName}>{otherLabel[p]}</span>
                      <span className={s.otherSum}>{otherSummary[p]}</span>
                    </span>
                    {ARROW}
                  </Link>
                </li>
              ))}
            </ul>
            <p className={s.ask}>To ask a question first, write to {contact}.</p>
          </section>
        </div>
      </div>
    </Shell>
  );
}
