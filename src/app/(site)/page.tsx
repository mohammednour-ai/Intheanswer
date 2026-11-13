import Link from "next/link";
import { ownerDetails } from "@/lib/env";
import { COPILOT_NAME } from "@/lib/brand";
import { sampleTeaser } from "@/lib/reports/sample";
import type { RowStatus } from "@/lib/reports/types";
import { SelfServeBox } from "./SelfServeBox";
import { Offers } from "./Offers";
import site from "./site.module.css";
import h from "./home.module.css";

const RESULT: Record<RowStatus, { label: string; meaning: string }> = {
  recommended: { label: "Recommended", meaning: "Put forward as an option." },
  listed_only: { label: "Listed only", meaning: "Mentioned or cited without being recommended." },
  not_named: { label: "Not named", meaning: "The clinic is not in the answer." },
};

/** The answer mark, drawn for one result: the middle line filled, outlined or dashed. */
function ResultMark({ status, width = 26 }: { status: RowStatus; width?: number }) {
  const middle =
    status === "recommended" ? <rect x="8" y="42" width="104" height="20" rx="10" fill="#1F4FD8" />
    : status === "listed_only" ? <rect x="11" y="45" width="98" height="14" rx="7" fill="#FFFFFF" stroke="#1F4FD8" strokeWidth="6" />
    : <rect x="11" y="45" width="98" height="14" rx="7" fill="none" stroke="#9AA4B2" strokeWidth="5" strokeDasharray="9 9" />;
  return (
    <svg width={width} height={Math.round((width * 104) / 120)} viewBox="0 0 120 104" aria-hidden="true">
      <rect x="8" y="8" width="84" height="20" rx="10" fill="#9AA4B2" />
      {middle}
      <rect x="8" y="76" width="64" height="20" rx="10" fill="#9AA4B2" />
    </svg>
  );
}

function Arrow({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" /><path d="M13 6l6 6-6 6" />
    </svg>
  );
}

/** Where a finding was seen: its evidence URLs, or the page addresses quoted in its text. */
function seenOn(f: { text: string; evidence: { url?: string | null }[] }): string[] {
  const urls = f.evidence.map((e) => e.url).filter((u): u is string => Boolean(u));
  if (urls.length) return urls;
  return [...f.text.matchAll(/\(([^\s()]+\.[^\s()]+)\)/g)].map((m) => m[1]);
}

export default function Home() {
  const o = ownerDetails();
  const sample = sampleTeaser();
  const rows = sample.rows.slice(1, 4);
  const finding = sample.findings[0];
  const findingPages = seenOn(finding);
  const total = sample.score.total;

  return (
    <>
      {/* ---------- hero ---------- */}
      <section className={`${h.hero} ${h.reset}`} aria-labelledby="hero-h">
        <div className={`${site.container} ${h.heroInner}`}>
          <div className={h.heroText}>
            <h1 id="hero-h" className={h.h1}>
              When patients ask AI, are you <span className={h.blue}>in the answer?</span>
            </h1>
            <p className={h.heroLead}>
              We ask an AI assistant the questions a patient in your city would ask, record which clinics it names, and
              show you what on your own website may be standing in the way. <strong>The first report is free.</strong>
            </p>
          </div>

          <div className={h.heroRow}>
            <div id="get-report" className={h.panel}>
              <SelfServeBox />
            </div>

            <figure className={h.figure}>
              <div className={h.figTag}>
                <span className={h.chip}>Illustration</span>
                <span className={h.muted13}>Not a real answer. The two clinics are invented.</span>
              </div>
              <div className={h.asks}>
                <span className={h.who}>A patient asks</span>
                <p className={h.bubble}>Which dentists in Barrie can see me the same day for a dental emergency?</p>
              </div>
              <div className={h.answers}>
                <span className={h.who}>An AI assistant answers, web search on</span>
                <div className={h.answerBox}>
                  <p className={h.answerText}>Three clinics in Barrie that say they take same-day emergencies:</p>
                  <ol className={h.lines}>
                    <li className={`${h.grey} ${h.w81}`}><strong>Clinic A</strong><span>(invented)</span></li>
                    <li>
                      <a href="#get-report" className={h.yours}>
                        <span className={h.yoursText}>
                          <span className={h.yoursName}>Your clinic?</span>
                          <span className={h.yoursSub}>Recommended, listed only, or not named</span>
                        </span>
                        <span className={h.yoursArrow}><Arrow size={18} /></span>
                      </a>
                    </li>
                    <li className={`${h.grey} ${h.w64}`}><strong>Clinic B</strong><span>(invented)</span></li>
                  </ol>
                </div>
              </div>
              <figcaption className={h.caption}>
                The blue line is the one we test. The free report tells you which of the three it is for your clinic, question by question.
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section className={`${site.band} ${site.bandRule} ${h.reset}`} aria-labelledby="how-h">
        <div className={`${site.container} ${site.stack}`}>
          <div className={h.sectionHead}>
            <div className={h.col8}>
              <span className={site.eyebrow}>What we do</span>
              <h2 id="how-h" className={site.h2}>How it works, in three steps</h2>
            </div>
            <Link href="/how-it-works" className={h.textLink}>Read how the test and the checks work</Link>
          </div>

          <ol className={h.steps}>
            <li className={h.step}>
              <div className={h.stepHead}><span aria-hidden="true" className={h.stepNum}>1</span><h3 className={h.stepTitle}>We ask</h3></div>
              <p className={h.stepText}>Five or six questions, worded the way a patient asks, put to an AI assistant with web search on, from your city.</p>
              <div className={h.stepBox}>
                <p className={h.smallBubble}>Which dentists in Barrie can see me the same day for a dental emergency?</p>
                <p className={h.muted13}>An example question. The assistant is not told about your clinic.</p>
              </div>
            </li>
            <li className={h.step}>
              <div className={h.stepHead}><span aria-hidden="true" className={h.stepNum}>2</span><h3 className={h.stepTitle}>We record</h3></div>
              <p className={h.stepText}>Every answer in full: which clinics were recommended, which were only listed, and the sources the assistant used.</p>
              <div className={h.stepBox}>
                <ul className={h.legend}>
                  <li><span aria-hidden="true" className={h.legendSlot}><span className={h.legendBar} style={{ width: 52, background: "var(--blue)" }} /></span>Clinics recommended</li>
                  <li><span aria-hidden="true" className={h.legendSlot}><span className={h.legendBar} style={{ width: 42 }} /></span>Clinics only listed</li>
                  <li><span aria-hidden="true" className={h.legendSlot}><span className={h.legendBar} style={{ width: 32 }} /></span>Sources the assistant used</li>
                </ul>
                <p className={h.muted13}>Every report names the assistant, the model and the date.</p>
              </div>
            </li>
            <li className={h.step}>
              <div className={h.stepHead}><span aria-hidden="true" className={h.stepNum}>3</span><h3 className={h.stepTitle}>We check your site</h3></div>
              <p className={h.stepText}>Hours, new-patient status, fees, practitioners, booking, speed on a phone, and whether tools can read it. Each finding comes with the page it was seen on.</p>
              <div className={h.stepBox}>
                <ul className={h.chips}>
                  {["Hours", "New patients", "Fees", "Practitioners", "Booking", "Speed on a phone", "Readable by tools"].map((c) => <li key={c}>{c}</li>)}
                </ul>
                <p className={h.muted13}>We read only your public website.</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      {/* ---------- the free report, in its parts ---------- */}
      <section className={`${site.band} ${site.bandSoft} ${h.reset}`} aria-labelledby="report-h">
        <div className={`${site.container} ${site.stack}`}>
          <div className={`${site.split} ${h.introSplit}`}>
            <div className={h.col8}>
              <span className={site.eyebrow}>What you get</span>
              <h2 id="report-h" className={site.h2}>The free report, in its own parts</h2>
            </div>
            <p className={site.body2}>
              The result for each question, the clinics named, and three findings from the website. The free report is yours to keep whether or not you buy anything.
            </p>
          </div>

          <div className={h.specimen}>
            <div className={h.specHead}>
              <span className={h.specLabel}>Sample report · Invented clinic</span>
              <span className={h.specClinic}>{sample.clinic.name} · {sample.clinic.city}, Ontario</span>
            </div>
            <div className={h.specBody}>
              <div className={`${h.part} ${h.part1}`}>
                <h3 className={h.partTitle}>1 · The score</h3>
                <div className={h.score}>
                  <span className={h.scoreLabel}>In the answer</span>
                  <span className={h.scoreNum}>{sample.score.recommended} <span className={h.scoreOf}>of {total}</span></span>
                  <span className={h.scoreText}>patient questions where the clinic was recommended</span>
                  <span className={h.scoreMore}>Mentioned without being recommended in {sample.score.listedOnly} more.</span>
                </div>
              </div>

              <div className={`${h.part} ${h.part2}`}>
                <h3 className={h.partTitle}>2 · What patients asked, and who was named</h3>
                <table className={h.table}>
                  <thead>
                    <tr>
                      <th scope="col">Patient question</th>
                      <th scope="col" className={h.resultCol}>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.answerId}>
                        <td>
                          <div className={h.qCell}>
                            <span className={h.muted13}>Question {r.questionIndex + 1} of {total}</span>
                            <span className={h.qText}>{r.question}</span>
                            <span className={h.qNamed}>Named instead: {r.namedInstead.length ? r.namedInstead.join(", ") : "none"}</span>
                          </div>
                        </td>
                        <td>
                          <span className={`${h.result} ${h[r.status]}`}>
                            <ResultMark status={r.status} />
                            {RESULT[r.status].label}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className={h.muted13}>{rows.length} of the {total} rows. The whole sample report shows all {total === 6 ? "six" : total}, with the answers.</p>
              </div>

              <div className={`${h.part} ${h.part3}`}>
                <h3 className={h.partTitle}>3 · What the three results mean</h3>
                <ul className={h.meaning}>
                  {(["recommended", "listed_only", "not_named"] as const).map((s) => (
                    <li key={s}>
                      <ResultMark status={s} width={40} />
                      <span className={h.meaningText}>
                        <span className={`${h.meaningName} ${h[s]}`}>{RESULT[s].label}</span>
                        <span className={h.meaningDesc}>{RESULT[s].meaning}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className={`${h.part} ${h.part4}`}>
                <h3 className={h.partTitle}>4 · A finding from the website</h3>
                <div className={h.finding}>
                  <div className={h.findingHead}>
                    <span aria-hidden="true" className={h.findingNum}>1</span>
                    <p className={h.findingTitle}>{finding.title}</p>
                  </div>
                  <p className={h.findingText}>{finding.text}</p>
                  {findingPages.length ? (
                    <dl className={h.seenOn}>
                      <dt>Seen on</dt>
                      <dd>{findingPages.join(" and ")}</dd>
                    </dl>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <div className={h.actions8}>
            <Link href="/sample" className={`${site.btnOutline} ${h.btnSmall}`}>Open the whole sample report<Arrow /></Link>
            <span className={h.sampleNote}>Taken from the sample report, where every clinic is invented. Yours will show what was observed.</span>
          </div>
        </div>
      </section>

      {/* ---------- limits ---------- */}
      <section className={`${site.bandInk} ${h.limits} ${h.reset}`} aria-labelledby="limits-h">
        <div className={`${site.container} ${h.limitsInner}`}>
          <div className={h.limitsTop}>
            <div className={h.limitsLeft}>
              <span className={h.eyebrowBlue}>What can it not tell me?</span>
              <h2 id="limits-h" className={h.bigH2}>No one can guarantee that a clinic will be named, and we do not promise it.</h2>
            </div>
            <div className={h.limitsRight}>
              <ul aria-label="A report is a snapshot" className={h.stats}>
                <li><span className={h.statNum}>1</span><span className={h.statLabel}>assistant</span></li>
                <li><span className={h.statNum}>5<span className={h.statOr}>or</span>6</span><span className={h.statLabel}>questions</span></li>
                <li><span className={h.statNum}>1</span><span className={h.statLabel}>day</span></li>
              </ul>
              <p className={h.snapshot}>
                A report is a snapshot: one assistant, a handful of questions, one day. Assistants change what they say, and results differ between assistants and apps.
              </p>
              <ul className={h.ruled}>
                <li>Five or six questions, not every way a patient might ask.</li>
                <li>The accessibility scan is automated checks, not a full accessibility audit.</li>
              </ul>
            </div>
          </div>
          <div className={h.behind}>
            <h3 className={h.behindTitle}>What we can stand behind: what was observed</h3>
            <ul className={h.behindList}>
              <li><span className={h.behindName}>Tied to evidence</span><span className={h.behindText}>Every finding is tied to stored evidence: the answer text, or the page where it was seen.</span></li>
              <li><span className={h.behindName}>Reread before it is sent</span><span className={h.behindText}>A separate verification pass rereads each sentence against that evidence and removes any claim it cannot match.</span></li>
              <li><span className={h.behindName}>Unknown stays unknown</span><span className={h.behindText}>What could not be checked is written “not detected” or “could not test”, never as a problem.</span></li>
            </ul>
          </div>
        </div>
      </section>

      {/* ---------- who is behind it ---------- */}
      <section className={`${site.band} ${h.reset}`} aria-labelledby="owner-h">
        <div className={`${site.container} ${h.owner}`}>
          <div className={h.ownerLeft}>
            <div className={h.col8}>
              <span className={site.eyebrow}>Who is writing to me?</span>
              <h2 id="owner-h" className={site.h2}>One person in Ontario, with a name and an address</h2>
            </div>
            <div className={h.nameBlock}>
              <p className={h.ownerName}>{o.name}</p>
              <p className={h.ownerBiz}>{o.businessName} · In The Answer</p>
            </div>
            <div className={h.note60}>
              <span className={h.draft}>[DRAFT: owner to approve]</span>
              <p className={h.quote}>
                I run In The Answer on my own, from Ontario. If a report from this address reached your clinic, I am the person who sent it, and I answer the questions about it myself.
              </p>
              <p className={site.body2}>
                A report says what one AI assistant said on one day, and what your public website showed. It does not promise that your clinic will be named.
              </p>
            </div>
          </div>
          <div className={h.ownerRight}>
            <h3 className={h.eyebrowH3}>Particulars</h3>
            <dl className={h.particulars}>
              <div><dt>Business</dt><dd className={h.strong}>{o.businessName}</dd></div>
              <div><dt>Mailing address</dt><dd className={h.strong}>{o.mailingAddress}</dd></div>
              <div><dt>Phone</dt><dd className={h.strong}>{o.phone}</dd></div>
              <div className={h.linkRow}><dt>Email</dt><dd><a href={`mailto:${o.email}`} className={h.inlineLink}>{o.email}</a></dd></div>
              <div><dt>Hours</dt><dd className={h.strong}>Monday to Friday, 9:00 am to 5:00 pm (Toronto time)</dd></div>
              <div><dt>AI disclosure</dt><dd>Reports are prepared by {COPILOT_NAME}, an AI system, and checked against stored evidence.</dd></div>
            </dl>
            <p className={h.webPerson}>
              <span className={h.webPersonLabel}>For your web person:</span>
              <Link href="/bot" className={h.inlineLink}>about our crawler</Link> and <Link href="/privacy" className={h.inlineLink}>privacy</Link>
            </p>
          </div>
        </div>
      </section>

      {/* ---------- plans ---------- */}
      <Offers />

      {/* ---------- who it is for, and if we emailed you ---------- */}
      <section className={`${site.band} ${site.bandSoft} ${h.reset}`} aria-label="Who it is for, and if we emailed you">
        <div className={`${site.container} ${h.forWrap}`}>
          <div className={h.forLeft}>
            <h2 className={h.h2Small}>Who it is for</h2>
            <p className={h.forText}>Independent dental clinics, walk-in and family clinics, and medspas in Ontario that have their own website.</p>
            <span className={`${site.eyebrow} ${h.eyebrowPad}`}>Example questions</span>
            <ul className={h.examples}>
              <li><span className={h.exampleKind}>Dental clinics</span><span className={h.smallBubble}>I just moved here. Can you recommend a dentist near me that is accepting new patients?</span></li>
              <li><span className={h.exampleKind}>Walk-in and family clinics</span><span className={h.smallBubble}>Which walk-in clinics near me are open on Sunday, and do I need to book ahead?</span></li>
              <li><span className={h.exampleKind}>Medspas</span><span className={h.smallBubble}>Which medspas near me list their prices for injectables, and who does the treatment?</span></li>
            </ul>
          </div>
          <div className={h.forRight}>
            <h2 className={h.h2Small}>If we emailed you</h2>
            <ul className={h.emailRules}>
              <li>We only write to an address a clinic publishes on its own website, and each email names the page where we found it.</li>
              <li>We write at most twice.</li>
              <li>Every email has an unsubscribe link that works at once, without a login.</li>
              <li>If a site says not to send solicitations, we do not write.</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ---------- closing call ---------- */}
      <section className={`${site.band} ${h.reset}`} aria-labelledby="close-h">
        <div className={`${site.container} ${h.close}`}>
          <div className={h.closeText}>
            <h2 id="close-h" className={h.bigH2}>Three lines in an answer. See which one is yours.</h2>
            <p className={h.closeLead}>
              Recommended, listed only, or not named: the free report shows the result for each question, the clinics named, and three findings from your website.
            </p>
            <div className={h.actions8}>
              <a href="#get-report" className={site.btnPrimary}>Get your clinic&apos;s free report</a>
              <Link href="/sample" className={h.plainLink}>See a sample report</Link>
            </div>
          </div>
          <div aria-hidden="true" className={h.closeArt}>
            <span className={h.w81} />
            <span className={h.closeBlue}>Your clinic?</span>
            <span className={h.w64} />
          </div>
        </div>
      </section>
    </>
  );
}
