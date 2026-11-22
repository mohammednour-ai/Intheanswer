import { BRAND, COPILOT_NAME, copilotAvatarSvg } from "../brand";
import { esc } from "../reports/html";

/**
 * The block a report page shows above its footer while calls are on: a link
 * to the page where the clinic can ask to be phoned. Self-contained (inline
 * styles), because it is added to stored report HTML of every layout when the
 * page is served. It says plainly that the caller is an AI.
 */
export function callLinkHtml(reportToken: string): string {
  return `<aside class="ita-call" aria-labelledby="ita-call-h" style="max-width:1120px;margin:0 auto;padding:8px clamp(20px,4vw,40px) 32px">
<style>@media print{.ita-call{display:none}}</style>
<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;border:1.5px solid ${BRAND.line};border-radius:12px;padding:20px;background:#fff;color:${BRAND.ink}">
  <div style="display:flex;gap:12px;align-items:flex-start;flex:1 1 320px">
    ${copilotAvatarSvg({ size: 36 })}
    <div><strong id="ita-call-h" style="display:block;font-size:17px;line-height:1.3">Would you rather talk it through?</strong>
    <span style="color:${BRAND.muted}">${esc(COPILOT_NAME)}, an AI assistant, can phone you and walk you through this report. You choose the number and nothing is dialled unless you ask.</span></div>
  </div>
  <a href="/call/${esc(reportToken)}" style="display:inline-flex;align-items:center;min-height:48px;padding:0 20px;border-radius:8px;background:${BRAND.blue};color:#fff;font-weight:600;text-decoration:none">Have it call me</a>
</div>
</aside>`;
}
