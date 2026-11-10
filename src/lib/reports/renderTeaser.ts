import { documentShell, esc } from "./html";
import { markSvg } from "../brand";
import type { TeaserData, RowStatus } from "./types";

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

export function reportHeader(docLabel: string): string {
  return `<header class="top">
  <div class="brand">${markSvg({ width: 30 })}<div class="wordmark">In The Answer</div></div>
  <div class="doc">${esc(docLabel)}</div>
</header>`;
}

export function renderTeaser(d: TeaserData): string {
  const sample = d.kind === "sample";
  const models = d.test.servedModels.join(", ");
  const rows = d.rows
    .map(
      (r) => `<tr>
  <td>${esc(r.question)}</td>
  <td>${r.namedInstead.length ? esc(r.namedInstead.join(", ")) : '<span class="none">No other clinic recommended</span>'}</td>
  <td class="st st-${r.status}">${STATUS_TEXT[r.status]}</td>
</tr>`,
    )
    .join("");

  const findings = d.findings
    .map((f, i) => {
      const urls = [...new Set(f.evidence.map((e) => e.url).filter(Boolean))].slice(0, 2);
      return `<div class="finding"><div class="n">${i + 1}</div><div class="t">${esc(f.title)}</div><p>${esc(f.text)}</p>${
        urls.length ? `<div class="src">Seen on ${urls.map((u) => esc(u)).join(" · ")}</div>` : ""
      }</div>`;
    })
    .join("");

  const body = `<div class="page">
${reportHeader("AI Visibility Report · Preview")}
<div class="who">
  ${sample ? '<div class="badge-sample">SAMPLE REPORT · INVENTED CLINIC</div>' : ""}
  <div class="label">Prepared for</div>
  <h1>${esc(d.clinic.name)}</h1>
  <div class="meta">${esc(d.clinic.city)}, Ontario · Tested ${esc(d.test.date)} · Assistant: ${esc(d.test.assistant)} (${esc(models)}), web search on</div>
</div>

<div class="hero">
  <div class="score"><div class="label">In the answer</div>
    <div class="num">${d.score.recommended} <span>of ${d.score.total}</span></div>
    <div class="cap">patient questions where your clinic was recommended</div></div>
  <div class="summary"><div class="head">${esc(headline(d))}</div><p>${esc(d.summary[0])}</p><p>${esc(d.summary[1])}</p></div>
</div>

<section>
  <h2>What patients asked, and who was named</h2>
  <div class="table-wrap"><table>
    <thead><tr><th scope="col" style="width:38%">Patient question</th><th scope="col" style="width:40%">Clinics recommended in the answer</th><th scope="col">Your clinic</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <div class="key"><strong>Recommended</strong>: put forward as an option. <strong>Listed only</strong>: mentioned or cited without being recommended. <strong>Not named</strong>: did not appear. Other clinics are listed exactly as the answer named them.</div>
</section>

<section>
  <h2>Three things we found on your website</h2>
  <div class="findings">${findings}</div>
</section>

<section>
  <h2>Two ways to fix it</h2>
  <div class="offers">
    <div class="offer">
      <div class="label">One time</div>
      <div class="price">200 CAD</div>
      <div style="font-weight:600">Full report and fix files</div>
      <p>All ${d.findingsTotal} findings and the fixes, ready for your web person to paste in. Includes one retest four weeks later.</p>
      <a class="btn" href="${esc(d.offers.oneTimeUrl)}">Get the full report</a>
    </div>
    <div class="offer main">
      <div class="row"><div class="label">Monthly plan</div><div class="pill">We do the work for you</div></div>
      <div class="price">200 CAD <span>per month · minimum ${esc(d.offers.minTerm)}</span></div>
      <ul>
        <li>Your website rebuilt or upgraded, with every fix installed by us</li>
        <li>The same questions retested every month, with a before and after</li>
        <li>A watch on the clinics named beside you, and what they changed</li>
        <li>Hours, notices and listings kept current all year</li>
      </ul>
      <a class="btn" href="${esc(d.offers.monthlyUrl)}">Start the monthly plan</a>
    </div>
  </div>
</section>

<footer class="foot">
  <div>${esc(d.limits)}</div>
  <div>In The Answer · intheanswer.ca · ${esc(d.owner.name)} · ${esc(d.owner.businessName)} · ${esc(d.owner.mailingAddress)} · ${esc(d.owner.phone)} · ${esc(d.owner.email)}</div>
</footer>
</div>`;
  return documentShell(`${d.clinic.name}: In the answer ${d.score.recommended} of ${d.score.total}`, body);
}
