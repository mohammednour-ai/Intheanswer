import { db } from "./db";
import { esc } from "./reports/html";
import { ownerDetails } from "./env";
import { CALL_CONSENT_TEXT, CALL_END, CALL_START, emailConsentText } from "./calls/consent";
import { OFFERS_END, OFFERS_START, renderOffers } from "./reports/renderTeaser";
import { loadOffers } from "./reports/teaser";
import type { TeaserData } from "./reports/types";

/** Simple per-visitor rate limit (per server instance): 30 page loads or 8 form posts a minute. */
const hits = new Map<string, number[]>();
export function rateLimited(key: string, max: number, windowMs = 60_000, now = Date.now()): boolean {
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) for (const k of hits.keys()) { hits.delete(k); if (hits.size < 2500) break; }
  return list.length > max;
}

export function clientIp(h: Headers): string {
  return (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "unknown";
}

/** Half-hour steps inside calling hours. */
function timeOptions(selected: string): string {
  const out: string[] = [];
  for (let m = 9 * 60 + 30; m <= 17 * 60; m += 30) {
    const v = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const h = Math.floor(m / 60), label = `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
    out.push(`<option value="${v}"${v === selected ? " selected" : ""}>${label}</option>`);
  }
  return out.join("");
}

const FORM_CSS = `<style>
.act{display:grid;grid-template-columns:1fr 1fr;gap:14px}.act form{border:1.5px solid var(--line);border-radius:10px;padding:16px 18px;display:flex;flex-direction:column;gap:8px}
.act label{font-weight:600;font-size:12.5px}.act input[type=text],.act input[type=tel],.act input[type=email],.act input[type=date],.act select{width:100%;min-height:44px;padding:8px 10px;border:1px solid #9AA4B2;border-radius:8px;font:14px Inter,sans-serif}
.act .chk{display:grid;grid-template-columns:24px 1fr;gap:8px;align-items:start;font-weight:400;font-size:12.5px}.act .chk input{width:20px;height:20px;margin:0}
.act button{min-height:44px;border-radius:8px;border:1.5px solid var(--ink);background:var(--ink);color:#fff;font:600 14px Inter,sans-serif;cursor:pointer}
.act .two{display:grid;grid-template-columns:1fr 1fr;gap:8px}.flash{border-radius:8px;padding:10px 12px;font-weight:600;background:var(--ground)}
@media (max-width:700px){.act{grid-template-columns:1fr}}
</style>`;

/** The two actions on the teaser page. Both consent boxes are unticked by default and required. */
export function renderActions(code: string, clinicName: string, src: string, flash: { done?: string | null; err?: string | null }): string {
  const o = ownerDetails();
  const emailText = emailConsentText(o.name, o.businessName);
  const msg =
    flash.done === "call" ? "Thank you. Your call request is recorded for the time you chose."
    : flash.done === "email" ? "Thank you. Your full results will be emailed to you."
    : flash.err ? flash.err : "";
  const s = esc(src);
  return `${FORM_CSS}<section id="next">
  <h2>See the full results</h2>
  ${msg ? `<p class="flash" role="status">${esc(msg)}</p>` : ""}
  <div class="act">
    <form method="post" action="/api/teaser/${code}/call">
      <strong>Request a call</strong>
      <span class="key">A short automated call from our assistant to explain the results for ${esc(clinicName)}. Monday to Friday, 9:30 am to 5:00 pm.</span>
      <input type="hidden" name="s" value="${s}">
      <label for="cn">Your name</label><input id="cn" name="name" type="text" required maxlength="100" autocomplete="name">
      <label for="cr">Your role</label><input id="cr" name="role" type="text" maxlength="80" placeholder="For example: owner, office manager">
      <label for="cp">Phone number</label><input id="cp" name="phone" type="tel" required autocomplete="tel">
      <label for="cd">Preferred day</label><input id="cd" name="date" type="date" required>
      <div class="two"><div><label for="cs">From</label><select id="cs" name="start">${timeOptions(CALL_START)}</select></div>
        <div><label for="ce">To</label><select id="ce" name="end">${timeOptions(CALL_END)}</select></div></div>
      <label class="chk"><input type="checkbox" name="consent" value="yes" required><span>${esc(CALL_CONSENT_TEXT)}</span></label>
      <button>Request a call</button>
    </form>
    <form method="post" action="/api/teaser/${code}/email">
      <strong>Email me the full results</strong>
      <span class="key">Every finding for ${esc(clinicName)}, sent to the address you give.</span>
      <input type="hidden" name="s" value="${s}">
      <label for="ee">Email address</label><input id="ee" name="email" type="email" required autocomplete="email">
      <label class="chk"><input type="checkbox" name="consent" value="yes" required><span>${esc(emailText)}</span></label>
      <button>Email me the full results</button>
    </form>
  </div>
  <p class="key" style="margin-top:10px">Do not want to hear from us? <a href="/optout?code=${code}">Stop all mail, email and calls</a>.</p>
</section>`;
}

/** Replace the baked offers with the current offers table (monthly plan first) and add the actions. */
export async function decorateTeaser(html: string, code: string, data: TeaserData, src: string, flash: { done?: string | null; err?: string | null }): Promise<string> {
  const a = html.indexOf(OFFERS_START), b = html.indexOf(OFFERS_END);
  const actions = renderActions(code, data.clinic.name, src, flash);
  if (a < 0 || b < 0) return html.replace('<footer class="foot">', `${actions}<footer class="foot">`);
  const offers = renderOffers(await loadOffers(), { ...data.offers, monthlyUrl: `/buy/${code}/monthly`, oneTimeUrl: `/buy/${code}/full_report` });
  return html.slice(0, a) + actions + offers + html.slice(b + OFFERS_END.length);
}

export async function latestTeaserFor(clinicId: string) {
  const [r] = await db()<{ id: string; html: string; data: TeaserData; place_id: string | null; city_id: number | null }[]>`
    select r.id, r.html, r.data, c.place_id, c.city_id from reports r join clinics c on c.id=r.clinic_id
    where r.clinic_id=${clinicId} and r.kind='teaser' and not r.superseded and (r.data->>'verified')::boolean
    order by r.created_at desc limit 1`;
  return r ?? null;
}
