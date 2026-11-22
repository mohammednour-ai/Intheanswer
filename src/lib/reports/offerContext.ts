import { db } from "../db";
import { env } from "../env";
import { DEFAULT_SWITCHES } from "../offer";
import { offerSwitches } from "../offerSwitches";
import { currentPlan } from "../calls/brief";
import type { OfferContext } from "./offerSection";

/**
 * What the plan section of a report needs to know about one clinic, read when
 * the report is shown or printed: where its buttons go, what it already has,
 * and which parts of the offer the owner has switched on. The section itself
 * (offerSection.ts) is wording and markup only.
 */

/** The public site, without a trailing slash. */
export const siteUrl = (): string => env().APP_URL.replace(/\/+$/, "");

/** "<site>/buy/<teaser token>": a plan key is added for each button (see src/app/buy). */
export const buyBaseOf = (teaserToken: string): string => `${siteUrl()}/buy/${teaserToken}`;

/**
 * Where a clinic's checkout links start: its newest teaser that passed the
 * gate (the one still in use first), as resolveBuyToken accepts it. Null when
 * the clinic has none.
 */
export async function buyBaseFor(clinicId: string): Promise<string | null> {
  const [t] = await db()<{ token: string }[]>`
    select token from reports where clinic_id=${clinicId} and kind='teaser' and data->>'verified' = 'true'
    order by superseded, created_at desc limit 1`;
  return t ? buyBaseOf(t.token) : null;
}

/**
 * `teaserToken`: pass it when the report being shown is itself a teaser that
 * passed the gate, so its buttons carry its own token and nothing is looked up.
 */
export async function offerContextFor(o: { clinicId: string | null; teaserToken?: string | null; findingsTotal?: number | null }): Promise<OfferContext> {
  const switches = await offerSwitches();
  const base = { site: siteUrl(), findingsTotal: o.findingsTotal ?? null, switches };
  if (!o.clinicId) return { ...base, buyBase: null, has: null };
  const [buyBase, has] = await Promise.all([o.teaserToken ? buyBaseOf(o.teaserToken) : buyBaseFor(o.clinicId), currentPlan(o.clinicId)]);
  return { ...base, buyBase, has };
}

/**
 * For the sample report: nobody to sell to, so the buttons go to the pricing
 * page. The sample must render even when the settings cannot be read, and
 * must not wait long for them: it then shows the launch setting.
 */
export async function sampleOfferContext(findingsTotal?: number | null): Promise<OfferContext> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = new Promise<typeof DEFAULT_SWITCHES>((resolve) => { timer = setTimeout(() => resolve(DEFAULT_SWITCHES), 3000); });
  const switches = await Promise.race([offerSwitches().catch(() => DEFAULT_SWITCHES), fallback]);
  clearTimeout(timer);
  return { buyBase: null, site: siteUrl(), findingsTotal: findingsTotal ?? null, has: null, switches };
}
