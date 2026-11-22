import { BRAND, VOICE_NAME, copilotAvatarSvg } from "../brand";
import { esc } from "../reports/html";
import type { CallOffer } from "./request";

/**
 * The block a report page shows above its footer while calls are on: a link
 * to the page where the clinic can ask to be phoned, and our own number with
 * the report's code for a clinic that would rather call us. Self-contained
 * (inline styles), because it is added to stored report HTML of every layout
 * when the page is served. It says plainly that the caller is an AI.
 */
export function callLinkHtml(reportToken: string, offer: CallOffer = { phone: null }): string {
  const p = offer.phone;
  const phoneUs = p
    ? `
  <p style="flex:1 1 100%;margin:0;padding-top:16px;border-top:1px solid ${BRAND.line};color:${BRAND.muted}">Or phone us at <a href="tel:${esc(p.e164)}" style="color:${BRAND.ink};font-weight:600;white-space:nowrap">${esc(p.display)}</a>, at any hour. The same assistant answers. Give it your clinic&#39;s name, or this report code: <strong style="color:${BRAND.ink};letter-spacing:.06em;white-space:nowrap">${esc(p.code.slice(0, 3))} ${esc(p.code.slice(3))}</strong>.</p>`
    : "";
  return `<aside class="ita-call" aria-labelledby="ita-call-h" style="max-width:1120px;margin:0 auto;padding:8px clamp(20px,4vw,40px) 32px">
<style>@media print{.ita-call{display:none}}</style>
<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;border:1.5px solid ${BRAND.line};border-radius:12px;padding:20px;background:#fff;color:${BRAND.ink}">
  <div style="display:flex;gap:12px;align-items:flex-start;flex:1 1 320px">
    <span style="flex:none;display:flex">${copilotAvatarSvg({ size: 36 })}</span>
    <div><strong id="ita-call-h" style="display:block;font-size:17px;line-height:1.3">Would you rather talk it through?</strong>
    <span style="color:${BRAND.muted}">${esc(VOICE_NAME)}, our AI assistant, can phone you and walk you through this report. You choose the number and nothing is dialled unless you ask.</span></div>
  </div>
  <a href="/call/${esc(reportToken)}" style="display:inline-flex;align-items:center;min-height:48px;padding:0 20px;border-radius:8px;background:${BRAND.blue};color:#fff;font-weight:600;text-decoration:none">Have it call me</a>${phoneUs}
</div>
</aside>`;
}
