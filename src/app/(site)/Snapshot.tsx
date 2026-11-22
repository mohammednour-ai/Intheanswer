import site from "./site.module.css";

/** What one report covers, for the ink band: one assistant, six questions, one day. */
export function Snapshot() {
  return (
    <>
      <ul aria-label="A report is a snapshot" className={site.stats}>
        <li><span className={site.statNum}>1</span><span className={site.statLabel}>assistant</span></li>
        <li><span className={site.statNum}>6</span><span className={site.statLabel}>questions</span></li>
        <li><span className={site.statNum}>1</span><span className={site.statLabel}>day</span></li>
      </ul>
      <p className={site.inkText}>
        A report is a snapshot: one assistant, six questions, one day. Assistants change what they say, and results differ between assistants and apps.
      </p>
    </>
  );
}
