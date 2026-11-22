import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ResultMark } from "../ResultMark";
import { Snapshot } from "../Snapshot";
import { TIERS, TIER_ORDER } from "@/lib/offer";
import { ClosingBand } from "../ClosingBand";
import { Banner } from "../Banner";
import site from "../site.module.css";
import styles from "./how.module.css";
import bannerImaging from "../images/banner-imaging-room.jpg";
import detailUltrasound from "../images/detail-ultrasound.jpg";

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

export default function HowItWorks() {
  return (
    <>
      <Banner id="hero-h" photo={bannerImaging} small>
        <h1 id="hero-h" className={site.h1}>How it works</h1>
        <p className={site.bannerLead}>How In The Answer tests AI assistants with patient questions, checks a clinic&rsquo;s website, and verifies every claim before a report is sent.</p>
      </Banner>

      <section className={styles.hero} aria-label="On this page">
        <div className={`${site.container} ${styles.heroRow}`}>
          <div className={styles.heroMain}>
            <span className={site.eyebrow}>The method, in four steps</span>
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
            <Image className={styles.heroPhoto} src={detailUltrasound} alt="" sizes="(max-width: 900px) 92vw, 600px" placeholder="blur" />
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
            <p className={styles.text}>We put six questions to an AI assistant with web search turned on, located in your city. The questions are written the way a patient asks, for example &ldquo;Which dentists in Barrie can see me the same day for a dental emergency?&rdquo; The assistant is not told about your clinic.</p>
          </div>
          <div className={`${styles.stepSide} ${styles.example}`}>
            <div className={styles.ask}>
              <span className={styles.askLabel}>An example question</span>
              <p className={site.bubble}>Which dentists in Barrie can see me the same day for a dental emergency?</p>
            </div>
            <dl className={styles.facts}>
              <div><dt>Questions</dt><dd>Six</dd></div>
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
                <ResultMark status="recommended" width={44} />
                <span className={styles.resultText}><span className={`${styles.resultName} ${styles.rec}`}>Recommended</span><span className={styles.resultDesc}>Put forward as an option.</span></span>
              </li>
              <li>
                <ResultMark status="listed_only" width={44} />
                <span className={styles.resultText}><span className={`${styles.resultName} ${styles.listed}`}>Listed only</span><span className={styles.resultDesc}>Mentioned or cited without being recommended.</span></span>
              </li>
              <li>
                <ResultMark status="not_named" width={44} />
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

      <section className={`${site.band} ${site.bandInk}`} aria-labelledby="limits-h">
        <div className={`${site.container} ${styles.row}`}>
          <div className={site.inkMain}>
            <h2 id="limits-h" className={site.inkLabel}>What are the limits?</h2>
            <p className={site.display}>No one can guarantee that a clinic will be named, and we do not promise it.</p>
          </div>
          <div className={site.inkSide}>
            <Snapshot />
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
            {TIER_ORDER.map((k) => {
              const plan = TIERS[k];
              const weDo = plan.whoDoesIt.startsWith("We ");
              return (
                <li key={k} className={k === "growth" ? styles.buyMain : undefined}>
                  <h3 className={styles.buyName}>{plan.name}</h3>
                  <p className={styles.buyWho}>{weDo ? <span className={styles.weDo}>{plan.whoDoesIt}</span> : plan.whoDoesIt}</p>
                  <p className={styles.buyText}>{plan.summary}</p>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <ClosingBand
        id="close-h"
        heading="Get your clinic’s free report"
        lead="Free. We read only your public website. We email the report once and do not add you to a list."
      >
        <Link className={site.btnPrimary} href="/#get-report">Get your free report</Link>
      </ClosingBand>
    </>
  );
}
