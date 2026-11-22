import { getSettings, type AppSettings } from "./settings";
import { readSwitches, type Switches } from "./offer";

/**
 * Which promises and pillars the owner has switched on (Portal > Settings >
 * The offer). `src/lib/offer.ts` holds the wording; this reads the choice.
 * A promise is stated, on any surface, only while it is on.
 */
export function switchesFrom(s: Pick<AppSettings, "offer_promises" | "offer_pillars"> | null | undefined): Switches {
  return readSwitches({ promises: s?.offer_promises, pillars: s?.offer_pillars });
}

export async function offerSwitches(): Promise<Switches> {
  return switchesFrom(await getSettings());
}
