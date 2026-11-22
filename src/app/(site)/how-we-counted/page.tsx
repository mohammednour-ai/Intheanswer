import type { Metadata } from "next";
import Link from "next/link";
import { BARRIE_QUESTIONS, TESTED, TESTED_BY_CITY } from "../tested";
import site from "../site.module.css";
import s from "./counted.module.css";

export const metadata: Metadata = {
  title: "How we counted",
  description: `How we counted ${TESTED.notRecommended} of ${TESTED.clinics} Ontario clinics that an AI assistant did not recommend in any of ${TESTED.questions} patient questions: the clinics, the questions, the assistant and the dates.`,
};

type Cell = [number, number] | null;
const KINDS: { key: "dental" | "family" | "medspa"; label: string }[] = [
  { key: "dental", label: "Dental" },
  { key: "family", label: "Walk-in and family" },
  { key: "medspa", label: "Medspa" },
];

const add = (cells: Cell[]): [number, number] =>
  cells.reduce<[number, number]>((t, c) => (c ? [t[0] + c[0], t[1] + c[1]] : t), [0, 0]);

function Figure({ cell }: { cell: Cell }) {
  if (!cell) return <span className={s.none}>not tested</span>;
  return <><strong>{cell[0]}</strong> <span className={s.of}>of {cell[1]}</span></>;
}

export default function HowWeCounted() {
  const columns = KINDS.map((k) => add(TESTED_BY_CITY.map((r) => r[k.key])));
  return (
    <div className={site.container}>
      <article className={`${site.prose} ${s.page}`}>
        <span className={site.eyebrow}>How we counted</span>
        <h1>
          {TESTED.notRecommended} of {TESTED.clinics} Ontario clinics were not recommended in any of {TESTED.questions} answers
        </h1>
        <p className={s.lead}>
          This page explains the figure on our home page: which clinics, which questions, which assistant, and when. It is a
          count of what one AI assistant said, not a measure of how good a clinic is.
        </p>

        <dl className={s.facts}>
          <div><dt>Clinics</dt><dd>{TESTED.clinics}, in {TESTED.cities} Ontario cities</dd></div>
          <div><dt>Questions</dt><dd>{TESTED.questions} per clinic, written the way a patient asks</dd></div>
          <div><dt>Assistant</dt><dd>{TESTED.assistant}, with web search on, located in the clinic&rsquo;s city</dd></div>
          <div><dt>Dates</dt><dd>{TESTED.from} to {TESTED.to}</dd></div>
        </dl>

        <h2>The count, by city and type of clinic</h2>
        <p>Each cell reads: clinics not recommended in any of the {TESTED.questions} answers, of the clinics tested.</p>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">City</th>
                {KINDS.map((k) => <th key={k.key} scope="col">{k.label}</th>)}
                <th scope="col">All</th>
              </tr>
            </thead>
            <tbody>
              {TESTED_BY_CITY.map((r) => (
                <tr key={r.city}>
                  <th scope="row">{r.city}</th>
                  {KINDS.map((k) => <td key={k.key}><Figure cell={r[k.key]} /></td>)}
                  <td><Figure cell={add(KINDS.map((k) => r[k.key]))} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">All</th>
                {columns.map((c, i) => <td key={KINDS[i].key}><Figure cell={c} /></td>)}
                <td><Figure cell={[TESTED.notRecommended, TESTED.clinics]} /></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className={s.note}>One Toronto clinic is listed on Google Maps under North York and was asked about North York; it is counted with Toronto.</p>

        <h2>Which clinics</h2>
        <p>
          Clinics listed on Google Maps in each city, each with its own website. One more asked us for its free report. We count
          every clinic we tested, including the ones we did not write to, so the figure is not limited to clinics that did
          badly. Each clinic is counted once, with its latest test.
        </p>

        <h2>How the questions were asked</h2>
        <p>
          For each city and type of clinic we asked the same {TESTED.questions} questions once, in a new conversation each time,
          with web search on and the location set to that city. The assistant was not told about any clinic. Every clinic of that
          type in that city was then checked against those {TESTED.questions} answers. All three types used the questions below, with
          the city&rsquo;s own name.
        </p>
        <div className={s.questions}>
          {BARRIE_QUESTIONS.map((g) => (
            <details key={g.kind} className={s.group}>
              <summary>{g.kind}: the six questions asked in Barrie</summary>
              <ol>{g.questions.map((q) => <li key={q}>{q}</li>)}</ol>
            </details>
          ))}
        </div>

        <h2>How an answer was marked</h2>
        <p>
          Each answer was marked for each clinic as <strong>Recommended</strong> (put forward as an option), <strong>Listed only</strong>{" "}
          (mentioned or cited without being recommended) or <strong>Not named</strong>. The match is automatic and cautious: a clinic counts
          as named only when its own distinctive name or its own web address appears in the answer, so a clinic that shares a street or
          a town name with another is not counted by mistake. A clinic is in the {TESTED.notRecommended} when none of its{" "}
          {TESTED.questions} answers recommended it.
        </p>

        <h2>What the count does not tell you</h2>
        <ul>
          <li>It is one assistant on one day for each city. Assistants change what they say, and other assistants and apps answer differently.</li>
          <li>Six questions are not every way a patient might ask.</li>
          <li>The clinics are those we found on Google Maps with a website, not every clinic in each city.</li>
          <li>A clinic that is not recommended may still be an excellent clinic. The count is about the answer, not the care.</li>
        </ul>

        <p className={s.note}>
          Counted on {TESTED.asOf} from our stored test results. Every answer and every match is kept, and a clinic can ask us for its
          own. Until {TESTED.asOf} our home page quoted 178 of 250, which counted only the clinics we had sent a report to.
        </p>

        <div className={site.actions}>
          <Link className={site.btnPrimary} href="/#get-report">Test your clinic for free</Link>
          <Link className={site.link} href="/sample">See a sample report</Link>
        </div>
      </article>
    </div>
  );
}
