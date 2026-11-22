import Image from "next/image";
import Link from "next/link";
import { env, ownerDetails } from "@/lib/env";
import { COPILOT_NAME } from "@/lib/brand";
import { displayPhone } from "@/lib/calls/phone";
import { POSITIONING, PROMISES, TIERS, pillarsOn, termText, type Switches } from "@/lib/offer";
import { sampleTeaser } from "@/lib/reports/sample";
import { rowTrend } from "@/lib/reports/monthly";
import type { RowStatus } from "@/lib/reports/types";
import { SelfServeBox } from "./SelfServeBox";
import { Offers } from "./Offers";
import { Promises } from "./Promises";
import { siteSwitches } from "./switches";
import { ResultMark } from "./ResultMark";
import { Snapshot } from "./Snapshot";
import { ClosingBand } from "./ClosingBand";
import { Banner } from "./Banner";
import { TESTED } from "./tested";
import site from "./site.module.css";
import h from "./home.module.css";
import bannerRoom from "./images/banner-treatment-room.jpg";
import detailMicroscope from "./images/detail-microscope.jpg";
import roomDental from "./images/room-dental.jpg";
import roomFamily from "./images/room-family.jpg";
import roomMedspa from "./images/room-medspa.jpg";

const RESULT: Record<RowStatus, { label: string; meaning: string }> = {
  recommended: { label: "Recommended", meaning: "Put forward as an option." },
  listed_only: { label: "Listed only", meaning: "Mentioned or cited without being recommended." },
  not_named: { label: "Not named", meaning: "The clinic is not in the answer." },
};

/** Who the service is for: a room of each kind of clinic, with a question a patient of that clinic might ask. */
const EXAMPLES = [
  { kind: "Dental clinics", photo: roomDental, question: "I just moved here. Can you recommend a dentist near me that is accepting new patients?" },
  { kind: "Walk-in and family clinics", photo: roomFamily, question: "Which walk-in clinics near me are open on Sunday, and do I need to book ahead?" },
  { kind: "Medspas", photo: roomMedspa, question: "Which medspas near me list their prices for injectables, and who does the treatment?" },
];

/** The page is rebuilt at most every ten minutes, so a change to the offer switches in the portal shows soon after. */
export const revalidate = 600;

/** What a monthly report holds today (the parts of ComparisonData in src/lib/reports/monthly.ts). */
const MONTHLY = [
  { name: "Every question, asked again", text: "The result now, beside the result before." },
  { name: "What went live", text: "Each new page, with its address and the date it was published." },
  { name: "What changed on your website", text: "Each check that moved, with what we saw before and what we see now." },
  { name: "What it cannot tell you", text: "The same limits as the first report: one assistant, a handful of questions, one day." },
];

/** The "now" results in the monthly illustration. Invented, like the clinic: one result moves, two do not. */
const NOW: RowStatus[] = ["listed_only", "not_named", "listed_only"];

/** Rules the service already follows. Each one is enforced in code or written into the terms on the pricing page. */
const CARE = [
  { name: "It says it is an AI", text: "Every report names the AI system that prepared it, and our phone assistant says it is an AI at the start of every call." },
  { name: "No patient information", text: "We read only your public website. We do not collect patient information, and we ask you not to share any on a call." },
  { name: "Nothing is published without you", text: "You confirm every clinical or pricing fact before it goes on your site, and you approve each new page." },
  { name: "No superlatives, no promises", text: "Wording is checked before anything is sent or published: no superlatives, no outcome promises, no comparisons with other clinics." },
  { name: "Your regulator's rules stay with you", text: "The final check of wording against your regulator's advertising rules is yours." },
];

/** Questions a clinic asks before the test. Plan names, terms and promises are read from src/lib/offer.ts. */
const faq = (switches: Switches) => [
  { q: "Can you guarantee that my clinic will be named?", a: "No. No one can guarantee what an AI assistant will say. We report what it said, fix what we can see on your website, and test again." },
  { q: "What do you need from us?", a: "For the free test, your website address and an email address at the clinic. If you start a monthly plan, we send an intake form, and you confirm every clinical or pricing fact before it is published." },
  {
    q: "What happens if we leave?",
    a: [
      `The one-time report has ${termText("report")}. ${TIERS.visibility.name} is ${termText("visibility")}; ${TIERS.growth.name} and ${TIERS.transformation.name} have a ${termText("growth")}.`,
      switches.promises.includes("ownership") ? PROMISES.ownership.text : "",
    ].filter(Boolean).join(" "),
  },
  { q: "Who does the work, a person or an AI?", a: `Reports are prepared by ${COPILOT_NAME}, an AI system, and every claim is checked against stored evidence before a report is sent. Your questions are answered by a person within one business day.` },
];

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

export default async function Home() {
  const switches = await siteSwitches();
  const o = ownerDetails();
  const sample = sampleTeaser();
  const rows = sample.rows.slice(1, 4);
  const finding = sample.findings[0];
  const findingPages = seenOn(finding);
  const total = sample.score.total;
  const recommendedOnce = TESTED.clinics - TESTED.notRecommended;
  // Our phone line, printed when it is set up. The page is built once, so this follows the setting at
  // deploy time; if calls are switched off later, the line answers with a short message instead.
  const ourNumber = env().TWILIO_PHONE_NUMBER ?? null;
  // the monthly illustration: the sample clinic's first three questions, each with an invented "now"
  const compare = sample.rows.slice(0, NOW.length).map((r, i) => ({ answerId: r.answerId, question: r.question, before: r.status, now: NOW[i] }));

  return (
    <>
      {/* ---------- hero: the picture band ---------- */}
      <Banner id="hero-h" photo={bannerRoom}>
        <h1 id="hero-h" className={`${site.h1} ${h.heroTitle}`}>
          Patients are asking AI where to go. <span className={`${site.accent} ${h.heroAccent}`}>Find out if it names you.</span>
        </h1>
        <p className={site.bannerLead}>
          One partner for your clinic&apos;s website and its place in AI answers. We test what an AI assistant says when
          patients ask, show you what on your website stands in the way, and can fix, rebuild and run the site for you.{" "}
          <strong>The test is free.</strong>
        </p>
        <div className={site.actions}>
          <a href="#get-report" className={site.btnPrimary}>Get your free AI visibility test</a>
          <a href="#plans-h" className={site.link}>See plans</a>
        </div>
      </Banner>

      {/* ---------- the form, beside the answer it is about ---------- */}
      <section className={`${h.start} ${h.reset}`} aria-labelledby="ss-h">
        <div className={site.container}>
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
                <p className={site.bubble}>Which dentists in Barrie can see me the same day for a dental emergency?</p>
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

      {/* ---------- the problem, in numbers from our own tests ---------- */}
      <section className={`${site.band} ${site.bandRule} ${h.reset}`} aria-labelledby="found-h">
        <div className={`${site.container} ${h.found}`}>
          <div className={h.foundMain}>
            <span className={site.eyebrow}>What we find</span>
            <h2 id="found-h" className={h.foundTitle}>
              <span className={h.foundFigure}>{TESTED.notRecommended} <span className={h.foundOf}>of {TESTED.clinics}</span></span>
              <span className={site.h2}>Ontario clinics we tested were not recommended in a single answer.</span>
            </h2>
          </div>
          <div className={h.foundSide}>
            <div className={h.split} aria-hidden="true">
              <span className={h.splitGrey} style={{ flexGrow: TESTED.notRecommended }} />
              <span className={h.splitBlue} style={{ flexGrow: recommendedOnce }} />
            </div>
            <ul className={h.splitList}>
              <li><span aria-hidden="true" className={`${h.swatch} ${h.swatchGrey}`} /><strong>{TESTED.notRecommended}</strong><span>not recommended in any of six answers</span></li>
              <li><span aria-hidden="true" className={`${h.swatch} ${h.swatchBlue}`} /><strong>{recommendedOnce}</strong><span>recommended in at least one</span></li>
            </ul>
            <p className={h.muted13}>
              Six patient questions for each clinic, put to an AI assistant with web search on. {TESTED.clinics} clinics
              in {TESTED.cities} Ontario cities, counted on {TESTED.asOf}.
            </p>
          </div>
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

      {/* ---------- who is behind it ---------- */}
      <section className={`${site.band} ${h.reset}`} aria-labelledby="owner-h">
        <div className={`${site.container} ${h.owner}`}>
          <div className={h.ownerLeft}>
            <div className={h.col8}>
              <span className={site.eyebrow}>Who is behind it?</span>
              <h2 id="owner-h" className={site.h2}>One partner, one monthly plan</h2>
            </div>
            <p className={h.about}>{POSITIONING}</p>
            <ul className={h.services}>
              {pillarsOn(switches).map((p) => (
                <li key={p.key}>
                  <span className={h.serviceName}>{p.title}</span>
                  <span className={h.serviceText}>{p.text}</span>
                </li>
              ))}
            </ul>
            <p className={`${site.body2} ${h.aboutNote}`}>
              A report says what one AI assistant said on one day, and what your public website showed. It does not promise that your clinic will be named.
            </p>
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

      {/* ---------- how it works: test, plan, build, run ---------- */}
      <section className={`${site.band} ${site.bandRule} ${h.reset}`} aria-labelledby="how-h">
        <div className={`${site.container} ${site.stack}`}>
          <div className={h.sectionHead}>
            <div className={h.col8}>
              <span className={site.eyebrow}>How it works</span>
              <h2 id="how-h" className={site.h2}>Test, plan, build, run</h2>
            </div>
            <Link href="/how-it-works" className={h.textLink}>Read how the test and the checks work</Link>
          </div>

          <ol className={`${h.steps} ${h.steps4}`}>
            <li className={h.step}>
              <div className={h.stepHead}><span aria-hidden="true" className={h.stepNum}>1</span><h3 className={h.stepTitle}>Test</h3></div>
              <span className={h.stepTag}>Free</span>
              <p className={h.stepText}>We ask an AI assistant, with web search on, the questions a patient in your city would ask, and we read your public website.</p>
              <div className={h.stepBox}>
                <p className={`${site.bubbleSmall} ${h.stepBubble}`}>Which dentists in Barrie can see me the same day for a dental emergency?</p>
                <p className={h.muted13}>An example question. The assistant is not told about your clinic.</p>
              </div>
            </li>
            <li className={h.step}>
              <div className={h.stepHead}><span aria-hidden="true" className={h.stepNum}>2</span><h3 className={h.stepTitle}>Plan</h3></div>
              <span className={h.stepTag}>Free report, then the full report</span>
              <p className={h.stepText}>You get the result for each question and three findings from your website. The full report lists every finding with its fix.</p>
              <div className={h.stepBox}>
                <ul className={h.resultsKey}>
                  {(["recommended", "listed_only", "not_named"] as const).map((s) => (
                    <li key={s} className={h[s]}><ResultMark status={s} />{RESULT[s].label}</li>
                  ))}
                </ul>
                <p className={h.muted13}>Every report names the assistant, the model and the date.</p>
              </div>
            </li>
            <li className={h.step}>
              <div className={h.stepHead}><span aria-hidden="true" className={h.stepNum}>3</span><h3 className={h.stepTitle}>Build</h3></div>
              <span className={h.stepTag}>{TIERS.visibility.name} or {TIERS.growth.name}</span>
              <p className={h.stepText}>We publish the answer pages and fix the listings. With {TIERS.growth.name} we also rebuild your website and keep it current. You approve each new page before it goes live.</p>
              <div className={h.stepBox}>
                <ul className={h.chips}>
                  {["Hours", "New patients", "Fees", "Practitioners", "Booking", "Speed on a phone", "Readable by tools"].map((c) => <li key={c}>{c}</li>)}
                </ul>
                <p className={h.muted13}>What the fixes cover.</p>
              </div>
            </li>
            <li className={h.step}>
              <div className={h.stepHead}><span aria-hidden="true" className={h.stepNum}>4</span><h3 className={h.stepTitle}>Run</h3></div>
              <span className={h.stepTag}>Every month</span>
              <p className={h.stepText}>The same questions are asked again each month. You get a report with each result before and now, and what we changed.</p>
              <div className={h.stepBox}>
                <ul className={h.chips}>
                  {["Monthly retest", "New answer pages", "Listings kept current", "A watch on the clinics named beside you"].map((c) => <li key={c}>{c}</li>)}
                </ul>
                <p className={h.muted13}>On every monthly plan.</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      {/* ---------- proof every month: the monthly report ---------- */}
      <section className={`${site.band} ${site.bandSoft} ${h.reset}`} aria-labelledby="monthly-h">
        <div className={`${site.container} ${h.monthly}`}>
          <div className={h.monthlyMain}>
            <div className={h.col8}>
              <span className={site.eyebrow}>Proof every month</span>
              <h2 id="monthly-h" className={site.h2}>Your monthly report</h2>
            </div>
            <p className={site.body2}>
              On every monthly plan, the same questions are asked again every month. The report
              sets each result beside the one before, so you can see what moved and what did not.
            </p>
            <ul className={h.monthlyList}>
              {MONTHLY.map((m) => (
                <li key={m.name}>
                  <span className={h.monthlyName}>{m.name}</span>
                  <span className={h.monthlyText}>{m.text}</span>
                </li>
              ))}
            </ul>
          </div>

          <figure className={h.monthlyFig}>
            <div className={h.figTag}>
              <span className={h.chip}>Illustration</span>
              <span className={h.muted13}>An invented clinic, with invented results.</span>
            </div>
            <ol className={h.compare}>
              {compare.map((r) => (
                <li key={r.answerId}>
                  <span className={h.qText}>{r.question}</span>
                  <span className={h.compareRow}>
                    <span className={h.compareCell}>
                      <span className={h.muted13}>Before</span>
                      <span className={`${h.result} ${h[r.before]}`}><ResultMark status={r.before} />{RESULT[r.before].label}</span>
                    </span>
                    <span className={h.compareCell}>
                      <span className={h.muted13}>Now</span>
                      <span className={`${h.result} ${h[r.now]}`}><ResultMark status={r.now} />{RESULT[r.now].label}</span>
                    </span>
                    <span className={h.trend}>{rowTrend(r)}</span>
                  </span>
                </li>
              ))}
            </ol>
            <figcaption className={h.muted13}>A result can stay the same or go down as well as up. The report shows it either way.</figcaption>
          </figure>
        </div>
      </section>

      {/* ---------- plans ---------- */}
      <Offers switches={switches} />

      {/* ---------- peace of mind ---------- */}
      <Promises switches={switches} />

      {/* ---------- limits ---------- */}
      <section className={`${site.band} ${site.bandInk} ${h.reset}`} aria-labelledby="limits-h">
        <div className={`${site.container} ${h.limitsInner}`}>
          <div className={h.limitsTop}>
            <div className={site.inkMain}>
              <span className={site.inkLabel}>What can it not tell me?</span>
              <h2 id="limits-h" className={site.display}>No one can guarantee that a clinic will be named, and we do not promise it.</h2>
            </div>
            <div className={site.inkSide}>
              <Snapshot />
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

      {/* ---------- built for healthcare ---------- */}
      <section className={`${site.band} ${h.reset}`} aria-labelledby="care-h">
        <div className={`${site.container} ${h.care}`}>
          <Image className={h.carePhoto} src={detailMicroscope} alt="" sizes="(max-width: 900px) 92vw, 460px" placeholder="blur" />
          <div className={h.careMain}>
            <div className={h.col8}>
              <span className={site.eyebrow}>Built for healthcare</span>
              <h2 id="care-h" className={site.h2}>Rules our AI follows on every report, page and call</h2>
            </div>
            <ul className={h.careList}>
              {CARE.map((c) => (
                <li key={c.name}>
                  <span className={h.careName}>{c.name}</span>
                  <span className={h.careText}>{c.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ---------- questions ---------- */}
      <section className={`${site.band} ${site.bandRule} ${h.reset}`} aria-labelledby="faq-h">
        <div className={`${site.container} ${site.stack}`}>
          <div className={h.sectionHead}>
            <div className={h.col8}>
              <span className={site.eyebrow}>Questions</span>
              <h2 id="faq-h" className={site.h2}>Before you ask for the test</h2>
            </div>
            <Link href="/pricing#questions" className={h.textLink}>Contracts, cancelling and refunds</Link>
          </div>
          <dl className={h.faq}>
            {faq(switches).map((x) => (
              <div key={x.q}>
                <dt>{x.q}</dt>
                <dd>{x.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ---------- who it is for, and if we emailed you ---------- */}
      <section className={`${site.band} ${site.bandSoft} ${h.reset}`} aria-labelledby="for-h">
        <div className={`${site.container} ${site.stack}`}>
          <div className={`${site.split} ${h.introSplit}`}>
            <div className={h.col8}>
              <span className={site.eyebrow}>Who it is for</span>
              <h2 id="for-h" className={site.h2}>Independent clinics in Ontario</h2>
            </div>
            <p className={site.body2}>
              Dental clinics, walk-in and family clinics, and medspas that have their own website. Under each picture is a question a patient of that kind of clinic might ask.
            </p>
          </div>

          <ul className={h.kinds}>
            {EXAMPLES.map((e) => (
              <li key={e.kind} className={h.kind}>
                <Image className={h.kindPhoto} src={e.photo} alt="" sizes="(max-width: 640px) 92vw, (max-width: 1000px) 46vw, 360px" placeholder="blur" />
                <div className={h.kindBody}>
                  <h3 className={h.kindName}>{e.kind}</h3>
                  <p className={site.bubbleSmall}>{e.question}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className={h.emailed}>
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
      <ClosingBand
        id="close-h"
        heading="See what AI says about your clinic."
        lead="Free. The form takes about two minutes, and the report usually reaches you within one business day."
      >
        <a href="#get-report" className={site.btnPrimary}>Get your free AI visibility test</a>
        <Link href="/sample" className={site.link}>See a sample report</Link>
        {ourNumber ? (
          <p className={site.actionsNote}>
            Already have a report? Call <a href={`tel:${ourNumber}`} className={h.telLink}>{displayPhone(ourNumber)}</a> and our AI assistant explains it.
          </p>
        ) : null}
      </ClosingBand>
    </>
  );
}
