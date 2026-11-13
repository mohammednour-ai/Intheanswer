import type { Metadata } from "next";
import Link from "next/link";
import site from "../site.module.css";
import styles from "./how.module.css";

export const metadata: Metadata = {
  title: "How it works",
  description: "How In The Answer tests AI assistants with patient questions, checks a clinic's website, and verifies every claim before a report is sent.",
};

const STEPS = [
  { href: "#test-h", name: "We ask" },
  { href: "#record-h", name: "We record" },
  { href: "#check-h", name: "We check your site" },
  { href: "#accuracy-h", name: "We verify" },
];

const QUESTIONS = [
  { href: "#test-h", q: "What do you test?" },
  { href: "#record-h", q: "What do you record?" },
  { href: "#check-h", q: "What do you check on my website?" },
  { href: "#accuracy-h", q: "How do I know the report is accurate?" },
  { href: "#limits-h", q: "What are the limits?" },
  { href: "#email-h", q: "How did you get my email address?" },
  { href: "#buy-h", q: "What happens if I buy?" },
];

const FACTS = [
  "New-patient status",
  "Hours, and whether two sets disagree",
  "Fees for uninsured services",
  "Insurance and direct billing",
  "Practitioner names and credentials",
  "Languages",
  "Areas served",
];

const SITE_CHECKS = ["The path to booking", "Layout and speed on a phone", "Broken links", "Whether AI crawlers are allowed"];

function StepTag({ n, name }: { n: number; name: string }) {
  return (
    <div className={styles.stepTag}>
      <span className={styles.stepNum} aria-hidden="true">{n}</span>
      <span className={site.eyebrow}>Step {n} of 4 · {name}</span>
    </div>
  );
}

/** The three-line mark, with the middle line drawn for each result. */
function ResultMark({ kind }: { kind: "rec" | "listed" | "none" }) {
  return (
    <svg width="44" height="38" viewBox="0 0 120 104" aria-hidden="true">
      <rect x="8" y="8" width="84" height="20" rx="10" fill="#9AA4B2" />
      {kind === "rec" && <rect x="8" y="42" width="104" height="20" rx="10" fill="#1F4FD8" />}
      {kind === "listed" && <rect x="11" y="45" width="98" height="14" rx="7" fill="#FFFFFF" stroke="#1F4FD8" strokeWidth="6" />}
      {kind === "none" && <rect x="11" y="45" width="98" height="14" rx="7" fill="none" stroke="#9AA4B2" strokeWidth="5" strokeDasharray="9 9" />}
      <rect x="8" y="76" width="64" height="20" rx="10" fill="#9AA4B2" />
    </svg>
  );
}

export default function HowItWorks() {
  return (
    <>
      <section className={styles.hero} aria-labelledby="hero-h">
        <div className={`${site.container} ${styles.heroRow}`}>
          <div className={styles.heroMain}>
            <h1 id="hero-h" className={styles.h1}>How it works</h1>
            <p className={styles.heroLead}>How In The Answer tests AI assistants with patient questions, checks a clinic&rsquo;s website, and verifies every claim before a report is sent.</p>
            <ol className={styles.steps} aria-label="The method, in order">
              {STEPS.map((s, i) => (
                <li key={s.href}>
                  <a href={s.href}>
                    <span className={styles.stepsNum} aria-hidden="true">{i + 1}</span>
                    <span className={styles.stepsName}>{s.name}</span>
                  </a>
                </li>
              ))}
            </ol>
          </div>
          <nav className={styles.toc} aria-labelledby="toc-h">
            <h2 id="toc-h" className={styles.tocTitle}>Seven questions on this page</h2>
            <ol className={styles.tocList}>
              {QUESTIONS.map((x, i) => (
                <li key={x.href}>
                  <a href={x.href}><span className={styles.tocNum} aria-hidden="true">{i + 1}</span>{x.q}</a>
                </li>
              ))}
            </ol>
          </nav>
        </div>
      </section>

      <section className={`${site.band} ${site.bandRule}`} aria-labelledby="test-h">
        <div className={`${site.container} ${styles.row}`}>
          <div className={styles.stepMain}>
            <StepTag n={1} name="We ask" />
            <h2 id="test-h" className={site.h2}>What do you test?</h2>
            <p className={styles.text}>We put five or six questions to an AI assistant with web search turned on, located in your city. The questions are written the way a patient asks, for example &ldquo;Which dentists in Barrie can see me the same day for a dental emergency?&rdquo; The assistant is not told about your clinic.</p>
          </div>
          <div className={`${styles.stepSide} ${styles.example}`}>
            <div className={styles.ask}>
              <span className={styles.askLabel}>An example question</span>
              <p className={styles.bubble}>Which dentists in Barrie can see me the same day for a dental emergency?</p>
            </div>
            <dl className={styles.facts}>
              <div><dt>Questions</dt><dd>Five or six</dd></div>
              <div><dt>Web search</dt><dd>On</dd></div>
              <div><dt>Asked from</dt><dd>Your city</dd></div>
              <div><dt>Told about your clinic</dt><dd>No</dd></div>
            </dl>
          </div>
        </div>
      </section>

      <section className={`${site.band} ${site.bandRule}`} aria-labelledby="record-h">
        <div className={`${site.container} ${styles.row}`}>
          <div className={styles.stepMain}>
            <StepTag n={2} name="We record" />
            <h2 id="record-h" className={site.h2}>What do you record?</h2>
            <p className={styles.text}>The full answer to each question, the sources it used, and every clinic it named. For your clinic, each question gets one of three results: <strong>recommended</strong> (put forward as an option), <strong>listed only</strong> (mentioned or cited without being recommended), or <strong>not named</strong>. Every report names the assistant, the model and the date.</p>
          </div>
          <div className={`${styles.stepSide} ${styles.results}`}>
            <h3 className={styles.resultsTitle}>One of three results for each question</h3>
            <ul className={styles.resultList}>
              <li>
                <ResultMark kind="rec" />
                <span className={styles.resultText}><span className={`${styles.resultName} ${styles.rec}`}>Recommended</span><span className={styles.resultDesc}>Put forward as an option.</span></span>
              </li>
              <li>
                <ResultMark kind="listed" />
                <span className={styles.resultText}><span className={`${styles.resultName} ${styles.listed}`}>Listed only</span><span className={styles.resultDesc}>Mentioned or cited without being recommended.</span></span>
              </li>
              <li>
                <ResultMark kind="none" />
                <span className={styles.resultText}><span className={`${styles.resultName} ${styles.notNamed}`}>Not named</span><span className={styles.resultDesc}>Did not appear.</span></span>
              </li>
            </ul>
            <p className={site.fine}>The result is always written as a word, never shown by colour alone.</p>
          </div>
        </div>
      </section>

      <section className={`${site.band} ${site.bandRule}`} aria-labelledby="check-h">
        <div className={`${site.container} ${site.stack}`}>
          <div className={styles.rowEnd}>
            <div className={styles.stepMain}>
              <StepTag n={3} name="We check your site" />
              <h2 id="check-h" className={`${site.h2} ${styles.unbalanced}`}>What do you check on my website?</h2>
            </div>
            <p className={`${styles.stepSide} ${styles.text}`}>Two groups of checks. We read only your public website, and each finding comes with the page it was seen on.</p>
          </div>
          <div className={styles.checks}>
            <div className={styles.checkCard}>
              <h3 className={styles.cardTitle}>The facts patients ask about</h3>
              <p className={styles.cardIntro}>Whether each one is stated in text:</p>
              <ul className={styles.checkList}>
                {FACTS.map((f) => <li key={f}><span className={styles.dash} aria-hidden="true" />{f}</li>)}
              </ul>
            </div>
            <div className={styles.checkCard}>
              <h3 className={styles.cardTitle}>The site itself</h3>
              <p className={styles.cardIntro}>What we test on the pages:</p>
              <ul className={styles.checkList}>
                {SITE_CHECKS.map((f) => <li key={f}><span className={styles.dash} aria-hidden="true" />{f}</li>)}
                <li className={styles.top}>
                  <span className={styles.dash} aria-hidden="true" />
                  <span>An automated accessibility scan<span className={styles.subNote}>Automated checks, not a full accessibility audit.</span></span>
                </li>
              </ul>
              <Link className={styles.arrowLink} href="/bot">
                About our crawler
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className={`${site.band} ${site.bandRule}`} aria-labelledby="accuracy-h">
        <div className={`${site.container} ${site.stack}`}>
          <div className={styles.headNarrow}>
            <StepTag n={4} name="We verify" />
            <h2 id="accuracy-h" className={site.h2}>How do I know the report is accurate?</h2>
          </div>
          <ol className={styles.rules}>
            <li>
              <span className={site.eyebrow}>Rule 1</span>
              <h3 className={styles.cardTitle}>Tied to evidence</h3>
              <p>Every finding is tied to stored evidence: the answer text or the page where it was seen.</p>
            </li>
            <li>
              <span className={site.eyebrow}>Rule 2</span>
              <h3 className={styles.cardTitle}>Reread before it is sent</h3>
              <p>A separate verification pass rereads each sentence against that evidence before anything is sent, and removes any claim it cannot match.</p>
            </li>
            <li>
              <span className={site.eyebrow}>Rule 3</span>
              <h3 className={styles.cardTitle}>Unknown stays unknown</h3>
              <p>When something could not be checked, the report says <strong>&ldquo;not detected&rdquo;</strong> or <strong>&ldquo;could not test&rdquo;</strong>. It is never presented as a problem.</p>
            </li>
          </ol>
        </div>
      </section>

      <section className={`${site.bandInk} ${styles.limits}`} aria-labelledby="limits-h">
        <div className={`${site.container} ${styles.row}`}>
          <div className={styles.limitsMain}>
            <h2 id="limits-h" className={styles.limitsLabel}>What are the limits?</h2>
            <p className={styles.limitsStatement}>No one can guarantee that a clinic will be named, and we do not promise it.</p>
          </div>
          <div className={styles.limitsSide}>
            <ul className={styles.snapshot} aria-label="A report is a snapshot">
              <li><span className={styles.snapNum}>1</span><span className={styles.snapLabel}>assistant</span></li>
              <li><span className={styles.snapNum}>5<span className={styles.snapOr}>or</span>6</span><span className={styles.snapLabel}>questions</span></li>
              <li><span className={styles.snapNum}>1</span><span className={styles.snapLabel}>day</span></li>
            </ul>
            <p className={styles.limitsText}>A report is a snapshot: one assistant, a handful of questions, one day. Assistants change what they say, and results differ between assistants and apps.</p>
          </div>
        </div>
      </section>

      <section className={site.band} aria-labelledby="email-h">
        <div className={`${site.container} ${styles.row}`}>
          <div className={styles.emailMain}>
            <span className={site.eyebrow}>If we emailed you</span>
            <h2 id="email-h" className={site.h2}>How did you get my email address?</h2>
            <p className={styles.text}>From your own website. These four rules apply to every email we send.</p>
          </div>
          <ol className={styles.emailRules}>
            <li><span className={styles.emailNum} aria-hidden="true">1</span><span className={styles.emailText}>We only write to an address a clinic publishes on its own website, and each email names the page where we found it.</span></li>
            <li><span className={styles.emailNum} aria-hidden="true">2</span><span className={styles.emailText}>We write at most twice.</span></li>
            <li><span className={styles.emailNum} aria-hidden="true">3</span><span className={styles.emailText}>Every email has an <Link href="/unsubscribe">unsubscribe link</Link> that works at once, without a login.</span></li>
            <li><span className={styles.emailNum} aria-hidden="true">4</span><span className={styles.emailText}>If your site says not to send solicitations, we do not write.</span></li>
          </ol>
        </div>
      </section>

      <section className={`${site.band} ${site.bandSoft}`} aria-labelledby="buy-h">
        <div className={`${site.container} ${site.stack}`}>
          <div className={styles.buyHead}>
            <div className={styles.buyTitle}>
              <span className={site.eyebrow}>After the free report</span>
              <h2 id="buy-h" className={site.h2}>What happens if I buy?</h2>
            </div>
            <Link className={styles.blueLink} href="/pricing">See pricing</Link>
          </div>
          <ul className={styles.buy}>
            <li>
              <h3 className={styles.buyName}>One-time report</h3>
              <p className={styles.buyWho}>Your web person installs</p>
              <p className={styles.buyText}>You receive every finding and the fix files, a short form for the facts only you know, and a retest four weeks later.</p>
            </li>
            <li>
              <h3 className={styles.buyName}>Monthly reports</h3>
              <p className={styles.buyWho}>Your web person installs</p>
              <p className={styles.buyText}>You get the same report and files, then an updated report every month.</p>
            </li>
            <li className={styles.buyMain}>
              <h3 className={styles.buyName}>Full service plan</h3>
              <p className={styles.buyWho}><span className={styles.weDo}>We do the work for you</span></p>
              <p className={styles.buyText}>We renovate your site or take it over, install the fixes, add two answer pages a month for your approval, and retest every month.</p>
            </li>
          </ul>
        </div>
      </section>

      <section className={site.band} aria-labelledby="close-h">
        <div className={`${site.container} ${styles.closeRow}`}>
          <div className={styles.closeMain}>
            <h2 id="close-h" className={styles.closeH2}>Get your clinic&rsquo;s free report</h2>
            <p className={styles.closeLead}>Free. We read only your public website. We email the report once and do not add you to a list.</p>
            <div className={site.actions}>
              <Link className={site.btnPrimary} href="/#get-report">Get your free report</Link>
            </div>
          </div>
          <div className={styles.bars} aria-hidden="true">
            <span className={`${styles.bar} ${styles.barTop}`} />
            <span className={`${styles.bar} ${styles.barYou}`}>Your clinic?</span>
            <span className={`${styles.bar} ${styles.barBottom}`} />
          </div>
        </div>
      </section>
    </>
  );
}
