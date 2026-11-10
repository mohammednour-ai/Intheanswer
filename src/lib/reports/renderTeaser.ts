import { documentShell, esc } from "./html";
import type { TeaserData, RowStatus } from "./types";

const STATUS_TEXT: Record<RowStatus, string> = {
  recommended: "Recommended",
  listed_only: "Listed only",
  not_named: "Not named",
};

export function renderTeaser(d: TeaserData): string {
  const sample = d.kind === "sample";
  const rows = d.rows
    .map(
      (r) => `<tr>
  <td class="q">${esc(r.question)}</td>
  <td class="st st-${r.status}">${STATUS_TEXT[r.status]}</td>
  <td class="named">${r.namedInstead.length ? esc(r.namedInstead.join(", ")) : '<span style="color:var(--muted)">None</span>'}</td>
</tr>`,
    )
    .join("");

  const findings = d.findings
    .map((f, i) => {
      const urls = [...new Set(f.evidence.map((e) => e.url).filter(Boolean))].slice(0, 2);
      return `<div class="finding"><div class="n">${i + 1}</div><div>
  <h3>${esc(f.title)}</h3><p>${esc(f.text)}</p>
  ${urls.length ? `<div class="src">Seen on: ${urls.map((u) => esc(u)).join(" · ")}</div>` : ""}
</div></div>`;
    })
    .join("");

  const models = d.test.servedModels.join(", ");
  const body = `<div class="page">
<header class="top">
  <div class="wordmark"><i aria-hidden="true"></i>In The Answer</div>
  <div class="meta">${sample ? '<span class="badge-sample">SAMPLE REPORT: INVENTED CLINIC</span><br>' : ""}
    Tested <strong>${esc(d.test.date)}</strong><br>Assistant: <strong>${esc(d.test.assistant)}</strong> (${esc(models)}), web search on</div>
</header>
<h1 class="clinic">${esc(d.clinic.name)}</h1>
<p class="sub">${esc(d.clinic.city)}, Ontario · ${esc(d.sector.name)} · ${esc(d.clinic.domain)}</p>

<section class="hero" aria-label="Result">
  <div class="score"><div class="lbl">In the answer</div><div class="num">${d.score.recommended} of ${d.score.total}</div>
    <div class="of">questions where the assistant recommended ${esc(d.clinic.name)}</div></div>
  <div class="summary"><p>${esc(d.summary[0])}</p><p>${esc(d.summary[1])}</p></div>
</section>

<h2>What patients asked, and who was named</h2>
<table><thead><tr><th scope="col">Question</th><th scope="col">${esc(d.clinic.name)}</th><th scope="col">Recommended in the answer</th></tr></thead>
<tbody>${rows}</tbody></table>
<p style="font-size:12.5px;color:var(--ink2);margin-top:8px"><strong>Recommended</strong>: put forward as an option. <strong>Listed only</strong>: mentioned or cited without being recommended. <em>Not named</em>: did not appear. Other clinics are listed exactly as the answer named them.</p>

<h2>Three things we found on your site</h2>
<div class="findings">${findings}</div>

<h2>What you can do</h2>
<div class="offers">
  <div class="offer"><h3>Full report and fix files</h3><div class="price">200 CAD</div><div>one time</div>
    <ul><li>Every finding with what was seen and the fix</li><li>Six ready-to-use fix files</li><li>One retest four weeks later</li></ul>
    <a class="btn" href="${esc(d.offers.oneTimeUrl)}">Get the full report</a></div>
  <div class="offer main"><span class="tag">Recommended</span><h3>Monthly plan</h3><div class="price">200 CAD / month</div><div>minimum term ${esc(d.offers.minTerm)}</div>
    <ul><li>Your website rebuilt or upgraded for you</li><li>Every fix installed</li><li>A retest every month with the same questions</li><li>Competitor watch: who is named instead of you</li></ul>
    <a class="btn" href="${esc(d.offers.monthlyUrl)}">Start the monthly plan</a></div>
</div>

<p class="limits">${esc(d.limits)}</p>
<p class="footer">${esc(d.owner.name)} · ${esc(d.owner.businessName)} · ${esc(d.owner.mailingAddress)} · ${esc(d.owner.phone)} · ${esc(d.owner.email)} · intheanswer.ca</p>
</div>`;
  return documentShell(`${d.clinic.name}: In the answer ${d.score.recommended} of ${d.score.total}`, body);
}
