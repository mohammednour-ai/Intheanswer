import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { chargesHst, ownerDetails } from "@/lib/env";
import { alreadyPurchased, dueToday, isPlan, requestQuote, resolveBuyToken, startCheckout } from "@/lib/payments/checkout";
import { checkoutState, minTermText, type Plan } from "@/lib/payments/stripe";
import { LEGACY_PLAN, REPORT_CREDIT_TEXT, TIERS, cad, offeredTo, planName, priceText, termText, tierIncludes, type TierKey } from "@/lib/offer";
import { offerSwitches } from "@/lib/offerSwitches";
import { Shell } from "../../Shell";
import site from "../../../(site)/site.module.css";
import s from "../../buy.module.css";

export const metadata: Metadata = { title: "Checkout", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Runs only on the button press, so a mail scanner that opens the link never
 * creates a checkout. `shown` is the first payment the page displayed: if a
 * credit ran out or was used in between, nothing is created and the page is
 * shown again with the amount that is due now.
 */
async function go(token: string, plan: string, shown: number) {
  "use server";
  if (!isPlan(plan)) notFound();
  const r = await startCheckout(token, plan, { expectCents: shown });
  if (r.kind === "redirect") redirect(r.url);
  if (r.kind === "not_found") notFound();
  // closed / already purchased / too many tries / amount changed: the page itself explains
  redirect(`/buy/${token}/${plan}${r.kind === "busy" ? "?e=busy" : r.kind === "changed" ? "?e=changed" : ""}`);
}

/** The plan that is quoted, not bought: the request goes to the owner. Nothing is charged. */
async function askForQuote(token: string, form: FormData) {
  "use server";
  if (String(form.get("ita_check_7q") ?? "")) redirect(`/buy/${token}/transformation?sent=1`); // bots get the same answer and nothing happens
  const r = await requestQuote(token, {
    phone: String(form.get("phone") ?? ""),
    bestTime: String(form.get("best_time") ?? ""),
    note: String(form.get("note") ?? ""),
  });
  if (!r.ok && r.reason === "not_found") notFound();
  redirect(`/buy/${token}/transformation?${r.ok ? "sent=1" : "e=busy"}`);
}

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

/** Numbered steps joined by a rail; the first is the one in blue. */
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

const STEPS: Record<TierKey, [string, string][]> = {
  report: [
    ["You pay", "By card, through Stripe. One payment."],
    ["The report is checked", "Before it is sent to the email address you give at payment."],
    ["The full report", "Every finding with the fix, and the fix files for your web person."],
    ["One retest", "Four weeks later, with a second report showing what changed."],
  ],
  visibility: [
    ["You pay", "By card, through Stripe. Billed each month."],
    ["The full report", "You get the full report first, checked before it is sent."],
    ["Access to your site", "We write to arrange it, so we can publish the answer pages and the fixes."],
    ["Every month", "A fresh retest, and a report showing what changed and what we did."],
  ],
  growth: [
    ["You pay", "By card, through Stripe. The first payment includes the setup."],
    ["The full report", "You get the full report first, checked before it is sent."],
    ["A short form about your website", "So we can begin the rebuild and set up the rest."],
    ["Every month", "A fresh retest, and a report showing what changed and what we did."],
  ],
  transformation: [
    ["You ask", "Leave a phone number. Nothing is charged here."],
    ["A short review", "A call about how your clinic works: booking, phones, forms, the tools you use."],
    ["A written quote", "What we would connect and build, the monthly price and the term."],
    ["You decide", "Nothing starts until you have agreed to the quote in writing."],
  ],
};

/** The other plans, one line each: the same three facts as the plan cards. */
function Others({ token, current, has, contact }: { token: string; current: TierKey; has: string | null; contact: React.ReactNode }) {
  const others = offeredTo(has).filter((k) => k !== current);
  if (!others.length) return <p className={s.ask}>To ask a question first, write to {contact}.</p>;
  return (
    <section className={s.other} aria-labelledby="other-h">
      <h2 id="other-h" className={s.label}>The other options</h2>
      <ul className={s.otherList}>
        {others.map((k) => (
          <li key={k}>
            <Link className={s.otherLink} href={`/buy/${token}/${k}`}>
              <span className={s.otherText}>
                <span className={s.otherName}>{TIERS[k].name}</span>
                <span className={s.otherSum}>{priceText(k)} · {TIERS[k].whoDoesIt} · {termText(k)}</span>
              </span>
              {ARROW}
            </Link>
          </li>
        ))}
      </ul>
      <p className={s.ask}>To ask a question first, write to {contact}.</p>
    </section>
  );
}

export default async function BuyPage(props: PageProps<"/buy/[token]/[plan]">) {
  const { token, plan: asked } = await props.params;
  const sp = await props.searchParams;
  const plan: Plan | "transformation" | null = isPlan(asked) ? asked : asked === "transformation" ? "transformation" : null;
  if (!plan) {
    // A link from before the plans changed leads to the plan that replaced it.
    if (Object.prototype.hasOwnProperty.call(LEGACY_PLAN, asked)) redirect(`/buy/${token}/${LEGACY_PLAN[asked]}?changed=1`);
    notFound();
  }
  const target = await resolveBuyToken(token);
  if (!target) notFound();
  const o = ownerDetails();
  const contact = <a href={`mailto:${o.email}`}>{o.email}</a>;
  const switches = await offerSwitches();
  const hst = chargesHst() && <> <span className={s.hst}>plus HST</span></>;
  const back = (
    <Link className={s.back} href={`/r/${token}`}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5" /><path d="M11 6l-6 6 6 6" /></svg>
      Back to your report
    </Link>
  );

  // ------------------------------------------------------------------ the plan that is quoted
  if (plan === "transformation") {
    const tier = TIERS.transformation;
    const has = await alreadyPurchased(target.clinicId, "report");
    return (
      <Shell wide>
        <div className={s.intro}>
          {back}
          <span className={site.eyebrow}>Quote</span>
          <h1 className={site.h1}>{tier.name}</h1>
          <p className={s.for}>For {target.clinicName}</p>
        </div>
        {sp.e === "busy" && <p className={`${s.notice} ${s.noticeWarn}`} role="alert">We already have your request. To add to it, write to {contact}.</p>}
        <div className={s.layout}>
          <section className={s.terms} aria-labelledby="terms-h">
            <h2 id="terms-h" className={s.label}>What it covers</h2>
            <p className={s.priceLine}>
              <span className={s.price}>{cad(tier.monthlyCents)}</span>
              <span><span className={s.per}>per month and up, quoted after a review</span>{hst}</span>
            </p>
            <ul className={s.rows}>
              <Row label="Who does the work"><span className={s.weDo}>{tier.whoDoesIt}</span></Row>
              <Row label="What you get">{tierIncludes("transformation", switches).join(". ")}.</Row>
              <Row label="Minimum term"><strong className={s.big}>{minTermText(tier.minTermMonths ?? 0)}</strong><Meter months={tier.minTermMonths ?? 0} /><span>Then month to month.</span></Row>
              <Row label="The price">Set in a written quote after a short review of how your clinic works. Nothing is charged on this page.</Row>
            </ul>
            {sp.sent === "1" ? (
              <p className={`${s.notice} ${s.noticeOk}`} role="status">Thank you. {o.name} will call you about a quote for {target.clinicName}. Nothing was charged.</p>
            ) : (
              <form action={askForQuote.bind(null, token)} className={s.panel}>
                <div className={site.field}>
                  <label htmlFor="phone">Phone number to call</label>
                  <input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" required maxLength={40} />
                </div>
                <div className={site.field}>
                  <label htmlFor="best_time">Best time to call (optional)</label>
                  <input id="best_time" name="best_time" type="text" maxLength={120} />
                </div>
                <div className={site.field}>
                  <label htmlFor="note">What would you like connected or built? (optional)</label>
                  <textarea id="note" name="note" rows={3} maxLength={600} />
                </div>
                {/* left empty by people; filled in by bots */}
                <div className={site.hp} aria-hidden="true">
                  <label htmlFor="ita_check_7q">Leave this empty</label>
                  <input id="ita_check_7q" name="ita_check_7q" type="text" tabIndex={-1} autoComplete="off" />
                </div>
                <button className={`${site.btnPrimary} ${site.go}`}>{tier.action}{ARROW}</button>
                <p className={s.fine}>A person calls you: {o.name}, {o.title}. Please do not put patient information in this form.</p>
              </form>
            )}
            <p className={s.fine}>
              What is included is described on the <Link href="/pricing">pricing page</Link>. No one can guarantee what an AI assistant will say; we report what it said and fix what we can see.
            </p>
          </section>
          <div className={s.aside}>
            <section className={s.next} aria-labelledby="next-h">
              <h2 id="next-h" className={s.h2}>What happens next</h2>
              <Steps steps={STEPS.transformation} />
            </section>
            <Others token={token} current="transformation" has={has} contact={contact} />
          </div>
        </div>
      </Shell>
    );
  }

  // ------------------------------------------------------------------ the plans bought online
  const has = await alreadyPurchased(target.clinicId, plan);
  if (has) {
    const onPlan = has !== "report";
    const larger = offeredTo(has).filter((k) => k !== "report");
    return (
      <Shell>
        <h1>{onPlan ? `You are already on ${planName(has)}` : "You already have the full report"}</h1>
        <p>
          {onPlan
            ? `${target.clinicName} is on ${planName(has)}${plan === "report" ? ", which includes the full report" : ""}. Nothing more needs to be paid here.`
            : `The full report for ${target.clinicName} is already paid for. Nothing was charged again.`}
        </p>
        {onPlan && plan !== "report" && offeredTo(has).includes(plan) && (
          <p>To move to {TIERS[plan].inSentence}, write to {contact} and we will switch you over without charging twice.</p>
        )}
        <p>If an email from us has not arrived, or this looks wrong, write to {contact}.</p>
        {!onPlan && larger.length > 0 && (
          <p>{larger.map((k, i) => <span key={k}>{i > 0 && " · "}<Link href={`/buy/${token}/${k}`}>See {TIERS[k].name}</Link></span>)}</p>
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

  const tier = TIERS[plan];
  const monthly = tier.kind === "subscription";
  const { cents: due, credit } = await dueToday(target.clinicId, plan);
  const includes = tierIncludes(plan, switches);
  return (
    <Shell wide>
      <div className={s.intro}>
        {back}
        <span className={site.eyebrow}>Checkout</span>
        <h1 className={site.h1}>{tier.name}</h1>
        <p className={s.for}>For {target.clinicName}</p>
      </div>
      {sp.changed === "1" && <p className={`${s.notice} ${s.noticeBlue}`} role="note">Our plans have changed since your link was made. The monthly work is now the {TIERS.visibility.name} plan, shown here.</p>}
      {sp.e === "busy" && <p className={`${s.notice} ${s.noticeWarn}`} role="alert">Too many tries in the last hour. Please try again later.</p>}
      {sp.e === "changed" && <p className={`${s.notice} ${s.noticeWarn}`} role="alert">The amount due today has changed since this page was opened. Please check it below, then continue.</p>}
      <div className={s.layout}>
        <section className={s.terms} aria-labelledby="terms-h">
          <h2 id="terms-h" className={s.label}>What you are buying</h2>
          <p className={s.priceLine}>
            <span className={s.price}>{cad(monthly ? tier.monthlyCents : tier.oneTimeCents)}</span>
            <span><span className={s.per}>{monthly ? `per month${tier.setupCents ? `, plus ${cad(tier.setupCents)} setup` : ""}` : "one time"}</span>{hst}</span>
          </p>
          <ul className={s.rows}>
            <Row label="Who does the work"><span className={monthly ? s.weDo : s.big}>{tier.whoDoesIt}</span></Row>
            {monthly ? (
              <>
                <Row label="Due today">
                  <strong className={s.big}>{cad(due)}</strong>
                  <span>
                    {tier.setupCents ? `The first month (${cad(tier.monthlyCents)}) and the setup (${cad(tier.setupCents)})` : "The first month"}
                    {credit ? `, less the ${cad(credit.cents)} you paid for the full report` : ""}. Then {cad(tier.monthlyCents)} each month, by card.
                  </span>
                </Row>
                <Row label="Minimum term">
                  {state.minTerm
                    ? <><strong className={s.big}>{minTermText(state.minTerm)}</strong><Meter months={state.minTerm} /><span>Then month to month.</span></>
                    : <><strong className={s.big}>None</strong><Meter months={0} /><span>Month to month from the start.</span></>}
                </Row>
                <Row label="Renewal"><strong className={s.rowStrong}>The plan renews each month until it is cancelled.</strong></Row>
                <Row label="What you get">{includes.join(". ")}. The domain name and the content stay yours.</Row>
                <Row label="To cancel">To cancel, write to us from the address you paid with.</Row>
              </>
            ) : (
              <>
                <Row label="Billing">One payment by card. No contract.</Row>
                <Row label="What you get">{includes.join(". ")}.</Row>
                <Row label="Delivery">The report is checked before it is sent to the email address you give at payment.</Row>
                <Row label="If you start a plan">{REPORT_CREDIT_TEXT}</Row>
                <Row label="Refunds">Refunds are given when the report has not yet been delivered. To ask for one, write to us from the address you paid with.</Row>
              </>
            )}
          </ul>
          <p className={s.fine}>
            What is included is described on the <Link href="/pricing">pricing page</Link>. No one can guarantee what an AI assistant will say; we report what it said and fix what we can see.
          </p>
          <form action={go.bind(null, token, plan, due)} className={s.form}>
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
            <Steps steps={STEPS[plan]} />
          </section>
          <Others token={token} current={plan} has={null} contact={contact} />
        </div>
      </div>
    </Shell>
  );
}
