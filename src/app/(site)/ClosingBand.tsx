import site from "./site.module.css";

/**
 * The last band of a page: a statement, what to do next (the children), and the
 * answer mark drawn large with "Your clinic?" on the blue line.
 */
export function ClosingBand({ id, heading, lead, children }: { id: string; heading: string; lead: string; children: React.ReactNode }) {
  return (
    <section className={site.band} aria-labelledby={id}>
      <div className={`${site.container} ${site.close}`}>
        <div className={site.closeText}>
          <h2 id={id} className={site.display}>{heading}</h2>
          <p className={site.closeLead}>{lead}</p>
          <div className={site.actions}>{children}</div>
        </div>
        <div aria-hidden="true" className={site.closeArt}>
          <span className={site.closeTop} />
          <span className={site.closeYou}>Your clinic?</span>
          <span className={site.closeBottom} />
        </div>
      </div>
    </section>
  );
}
