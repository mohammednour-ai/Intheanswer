import { promisesOn, type Switches } from "@/lib/offer";
import site from "./site.module.css";

/**
 * What a clinic can count on: the promises the owner has switched on, in the exact wording of
 * src/lib/offer.ts. A promise that is switched off is not shown, and with none on the section is
 * left out. Never write a promise on a page by hand.
 */
export function Promises({ switches }: { switches: Switches }) {
  const list = promisesOn(switches);
  if (!list.length) return null;
  return (
    <section className={`${site.band} ${site.bandRule}`} aria-labelledby="promises-h">
      <div className={`${site.container} ${site.stack}`}>
        <div className={site.headCol}>
          <span className={site.eyebrow}>Peace of mind</span>
          <h2 id="promises-h" className={site.h2}>What you can count on</h2>
        </div>
        <dl className={site.promises}>
          {list.map((p) => (
            <div key={p.key}>
              <dt>{p.title}</dt>
              <dd>{p.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
