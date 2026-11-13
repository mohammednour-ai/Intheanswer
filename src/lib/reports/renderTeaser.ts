import { documentShell, esc } from "./html";
import { markSvg, copilotAvatarSvg, COPILOT_NAME } from "../brand";
import type { TeaserData, RowStatus } from "./types";
import { LIVE_REVIEWS_MARKER } from "../reviews/liveTable";

/** Teaser layout follows the owner's design canvas ("Teaser report (free)"). */

const STATUS_TEXT: Record<RowStatus, string> = {
  recommended: "Recommended",
  listed_only: "Listed only",
  not_named: "Not named",
};

/** A factual one-line headline derived only from the verified score. */
export function headline(d: TeaserData): string {
  const { recommended: r, listedOnly: l, total: t } = d.score;
  if (r > 0) return `Recommended in ${r} of ${t} answers.`;
  if (l > 0) return `Named in ${l} of ${t} answers, recommended in none.`;
  return `Not named in any of the ${t} answers.`;
}

/** Copilot byline, as on the design canvas: always says it is an AI system. */
export function copilotByline(ownerName: string): string {
  return `<div class="byline">${copilotAvatarSvg({ size: 28, dot: false })}<div>Prepared by <strong>${COPILOT_NAME}</strong>, an AI system, for ${esc(ownerName)}, In The Answer. Every claim checked against stored evidence.</div></div>`;
}

export function reportHeader(docLabel: string): string {
  return `<header class="top">
  <div class="brand">${markSvg({ width: 30 })}<div class="wordmark">In The Answer</div></div>
  <div class="doc">${esc(docLabel)}</div>
</header>`;
}

/**
 * The answer mark redrawn for one result: the middle bar filled blue (recommended), outlined blue
 * (listed only) or a grey dashed gap (not named). Decorative: the result word always sits beside it.
 */
function statusMark(status: RowStatus, width: number): string {
  const h = Math.round((width * 104) / 120);
  const grey = "#9AA4B2";
  const middle =
    status === "recommended"
      ? '<rect x="8" y="42" width="104" height="20" rx="10" fill="#1F4FD8"/>'
      : status === "listed_only"
        ? '<rect x="11" y="45" width="98" height="14" rx="7" fill="#FFFFFF" stroke="#1F4FD8" stroke-width="6"/>'
        : `<rect x="11" y="45" width="98" height="14" rx="7" fill="none" stroke="${grey}" stroke-width="5" stroke-dasharray="9 9"/>`;
  return `<svg width="${width}" height="${h}" viewBox="0 0 120 104" aria-hidden="true"><rect x="8" y="8" width="84" height="20" rx="10" fill="${grey}"/>${middle}<rect x="8" y="76" width="64" height="20" rx="10" fill="${grey}"/></svg>`;
}

const ARROW =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>';
const ARROW_OUT =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"/><path d="M9 7h8v8"/></svg>';

/** Twelve cells, the first `months` filled: how long a plan commits you. */
function meter(term: string): string {
  const months = Math.min(12, Number(term.match(/^(\d+)/)?.[1] ?? 0));
  return `<span class="rp-meter" aria-hidden="true">${Array.from({ length: 12 }, (_, i) => `<span${i < months ? ' class="on"' : ""}></span>`).join("")}</span>`;
}

/** The site the report's links point back to (the buy links carry it), so the PDF's links work too. */
function siteOrigin(d: TeaserData): string {
  try {
    return new URL(d.offers.oneTimeUrl).origin;
  } catch {
    return "https://intheanswer.ca";
  }
}

export function renderTeaser(d: TeaserData): string {
  const sample = d.kind === "sample";
  const models = d.test.servedModels.join(", ");
  const site = siteOrigin(d);
  const notNamed = Math.max(0, d.score.total - d.score.recommended - d.score.listedOnly);

  const rows = d.rows
    .map(
      (r, i) => `<li class="rp-q">
  <div class="rp-status">${statusMark(r.status, 34)}<span class="rp-word c-${r.status}">${STATUS_TEXT[r.status]}</span></div>
  <p class="rp-question"><span class="rp-qn">${i + 1}</span><span>${esc(r.question)}</span></p>
  <div class="rp-named"><span class="rp-namedlabel">Clinics recommended in the answer</span>${
    r.namedInstead.length
      ? `<ul class="rp-chips">${r.namedInstead.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
      : '<p class="rp-none">No other clinic recommended</p>'
  }</div>
</li>`,
    )
    .join("");

  const bar = d.rows.map((r) => `<span class="s-${r.status}"></span>`).join("");

  const findings = d.findings
    .map((f, i) => {
      const urls = [...new Set(f.evidence.map((e) => e.url).filter(Boolean))].slice(0, 2);
      return `<li class="rp-finding"><div class="rp-fhead"><span class="rp-fn" aria-hidden="true">${i + 1}</span><h3 class="rp-h3">${esc(f.title)}</h3></div><p>${esc(f.text)}</p>${
        urls.length ? `<p class="rp-src">Seen on ${urls.map((u) => esc(u)).join(" · ")}</p>` : ""
      }</li>`;
    })
    .join("");

  const three = Boolean(d.offers.reportsUrl);
  const reportsTerm = d.offers.reportsMinTerm ?? "";
  const contract = `${d.offers.minTerm.replace(/^(\d+) months?$/, "$1-month")} contract`;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const row = (dt: string, dd: string, cls = "") => `<div><dt>${dt}</dt><dd${cls ? ` class="${cls}"` : ""}>${dd}</dd></div>`;

  const body = `<div class="rp">
<header class="rp-top"><div class="rp-wrap"><div class="rp-topbar">
  <a class="rp-brand" href="${esc(site)}/">${markSvg({ width: 30 })}<span class="rp-wordmark">In The Answer</span></a>
  <a class="rp-site" href="${esc(site)}/">intheanswer.ca${ARROW_OUT}</a>
  <p class="rp-doc">AI Visibility Report · Preview</p>
</div></div></header>

<main>
<section class="rp-who" aria-labelledby="clinic-h"><div class="rp-wrap">
  ${sample ? '<span class="rp-badge">SAMPLE REPORT · INVENTED CLINIC</span>' : ""}
  <span class="rp-eyebrow rp-prepared">Prepared for</span>
  <h1 id="clinic-h" class="rp-h1">${esc(d.clinic.name)}</h1>
  <p class="rp-meta">${esc(d.clinic.city)}, Ontario · Tested ${esc(d.test.date)} · Assistant: ${esc(d.test.assistant)} (${esc(models)}), web search on</p>
</div></section>

<section class="rp-scoresec" aria-labelledby="score-h"><div class="rp-wrap"><div class="rp-panel">
  <div class="rp-score">
    <h2 id="score-h" class="rp-eyebrow">In the answer</h2>
    <div class="rp-scoreline">
      <p class="rp-num"><span class="rp-n">${d.score.recommended}</span> <span class="rp-of">of ${d.score.total}</span></p>
      <p class="rp-cap">patient questions where your clinic was recommended</p>
    </div>
    <div class="rp-tally">
      <span class="rp-bar" aria-hidden="true">${bar}</span>
      <p class="rp-counts"><strong class="c-recommended">${d.score.recommended} Recommended</strong> · <strong class="c-listed_only">${d.score.listedOnly} Listed only</strong> · <strong class="c-not_named">${notNamed} Not named</strong></p>
    </div>
  </div>
  <div class="rp-summary">
    <p class="rp-headline">${esc(headline(d))}</p>
    <p class="rp-text">${esc(d.summary[0])}</p>
    <p class="rp-text">${esc(d.summary[1])}</p>
  </div>
</div></div></section>

<section class="rp-qsec" aria-labelledby="q-h"><div class="rp-wrap rp-stack">
  <h2 id="q-h" class="rp-h2">What patients asked, and who was named</h2>
  <div>
    <div class="rp-qhead" aria-hidden="true"><span>Your clinic</span><span>Patient question</span><span>Clinics recommended in the answer</span></div>
    <ol class="rp-qlist">${rows}</ol>
  </div>
  <div class="rp-legend">
    <h3 class="rp-h3s">One of three results for each question</h3>
    <ul class="rp-keys">
      <li>${statusMark("recommended", 40)}<span><span class="rp-word c-recommended">Recommended</span><span class="rp-def">put forward as an option.</span></span></li>
      <li>${statusMark("listed_only", 40)}<span><span class="rp-word c-listed_only">Listed only</span><span class="rp-def">mentioned or cited without being recommended.</span></span></li>
      <li>${statusMark("not_named", 40)}<span><span class="rp-word c-not_named">Not named</span><span class="rp-def">did not appear.</span></span></li>
    </ul>
    <p class="rp-fine">Other clinics are listed exactly as the answer named them.</p>
  </div>
</div></section>

<section class="rp-band" aria-labelledby="find-h"><div class="rp-wrap rp-stack">
  <h2 id="find-h" class="rp-h2">Three things we found on your website</h2>
  <ol class="rp-findings">${findings}</ol>
</div></section>

<div class="rp-wrap rp-live">${LIVE_REVIEWS_MARKER}</div>

<section class="rp-band rp-plansec" aria-labelledby="plans-h"><div class="rp-wrap rp-stack">
  <div class="rp-planshead">
    <h2 id="plans-h" class="rp-h2">${three ? "Three" : "Two"} ways to fix it</h2>
    <p>The free report is yours to keep whether or not you buy anything.</p>
  </div>
  <ul class="rp-glance" aria-label="The ${three ? "three" : "two"} options in short">
    <li><strong>One time</strong>200 CAD · your web person installs · no contract</li>
    ${three ? `<li><strong>Monthly reports</strong>150 CAD, then 50 CAD per month · your web person installs · minimum term ${esc(reportsTerm)}</li>` : ""}
    <li><strong>Full service plan</strong>200 CAD per month · we do the work for you · <span class="rp-nowrap">${esc(contract)}</span></li>
  </ul>
  <div class="rp-plans">
    <article class="rp-plan">
      <div class="rp-planhead"><h3 class="rp-planname">One time</h3><p class="rp-price">200 CAD</p><p class="rp-plansub">Full report and fix files</p></div>
      <dl class="rp-dl">
        ${row("Who installs the fixes", '<span class="rp-big">Your web person</span>', "rp-installs")}
        ${row("How long you commit", `<span class="rp-big">No contract</span>${meter("0")}`, "rp-term")}
        ${row("Retests", "One retest four weeks later", "rp-retest")}
      </dl>
      <p>All ${d.findingsTotal} findings and the fixes, ready for your web person to paste in. Includes one retest four weeks later.</p>
      <a class="rp-btn" href="${esc(d.offers.oneTimeUrl)}">Get the full report${ARROW}</a>
    </article>
    ${three ? `<article class="rp-plan">
      <div class="rp-planhead"><h3 class="rp-planname">Monthly reports</h3><p class="rp-price">150 CAD <small>first month</small></p><p class="rp-plansub">then 50 CAD per month · minimum ${esc(reportsTerm)}</p></div>
      <dl class="rp-dl">
        ${row("Who installs the fixes", '<span class="rp-big">Your web person</span>', "rp-installs")}
        ${row("How long you commit", `<span class="rp-big">Minimum term ${esc(reportsTerm)}</span>${meter(reportsTerm)}`, "rp-term")}
        ${row("Retests", "Retested every month, with an updated report", "rp-retest")}
      </dl>
      <p>The full report and fix files now, then a fresh retest and an updated report every month. Your web person installs the fixes.</p>
      <a class="rp-btn" href="${esc(d.offers.reportsUrl ?? "")}">Start monthly reports${ARROW}</a>
    </article>` : ""}
    <article class="rp-plan main">
      <div class="rp-planhead"><h3 class="rp-planname">Full service plan</h3><p class="rp-price">200 CAD</p><p class="rp-plansub">per month · ${esc(contract)}</p></div>
      <dl class="rp-dl">
        ${row("Who installs the fixes", '<span class="rp-wedo">We do the work for you</span>', "rp-installs")}
        ${row("How long you commit", `<span class="rp-big">${esc(cap(contract))}</span>${meter(d.offers.minTerm)}`, "rp-term")}
        ${row("Retests", "Retested every month, with a before and after", "rp-retest")}
      </dl>
      <ul>
        <li>Your website renovated, or taken over and run by us, with every fix installed</li>
        <li>The same questions retested every month, with a before and after</li>
        <li>A watch on the clinics named beside you, and what they changed</li>
        <li>Hours, notices and listings kept current all year</li>
      </ul>
      <a class="rp-btn" href="${esc(d.offers.monthlyUrl)}">Start the full service plan${ARROW}</a>
    </article>
  </div>
  <p class="rp-note">Prices are in Canadian dollars, plus HST. No one can guarantee what an AI assistant will say; we report what it said and fix what we can see. <a href="${esc(site)}/pricing">Contracts, cancelling and refunds are on the pricing page.</a></p>
</div></section>
</main>

<footer class="rp-foot"><div class="rp-wrap"><div class="rp-footin">
  ${copilotByline(d.owner.name)}
  <p class="rp-limits">${esc(d.limits)}</p>
  <p class="rp-contact">In The Answer · intheanswer.ca · ${esc(d.owner.name)} · ${esc(d.owner.businessName)} · ${esc(d.owner.mailingAddress)} · ${esc(d.owner.phone)} · <a href="mailto:${esc(d.owner.email)}">${esc(d.owner.email)}</a></p>
</div></div></footer>
</div>`;
  return documentShell(`${d.clinic.name}: In the answer ${d.score.recommended} of ${d.score.total}`, body);
}
