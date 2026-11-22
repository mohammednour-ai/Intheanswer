import { DEFAULT_SWITCHES, type Switches } from "@/lib/offer";
import { offerSwitches } from "@/lib/offerSwitches";

/**
 * Which pillars and promises a public page may show: the owner's choice in Portal > Settings.
 *
 * A page that calls this sets `export const revalidate = 600`, so a change in the portal reaches
 * the site within ten minutes. When the settings cannot be read:
 * - while the site is being built, or in development, the launch setting is used, so a build
 *   never depends on a database;
 * - on the live site the error is thrown, and the page keeps the last copy that was built from
 *   the owner's real choice. A promise the owner switched off must not come back by accident.
 */
export async function siteSwitches(): Promise<Switches> {
  try {
    return await offerSwitches();
  } catch (e) {
    if (process.env.NEXT_PHASE === "phase-production-build" || process.env.NODE_ENV !== "production") return DEFAULT_SWITCHES;
    throw e;
  }
}
