import { ANSWER_PLACEHOLDERS, expandAnswer, listAnswers } from "@/lib/answers";
import { VOICE_NAME } from "@/lib/brand";
import { saveAnswerAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * The answers the business gives to the questions and objections clinics
 * raise. The email reply drafts and the phone assistant both use them, so a
 * change here changes what is written and what is said.
 */
export default async function AnswersPage(props: PageProps<"/portal/answers">) {
  const sp = await props.searchParams;
  const saved = typeof sp.saved === "string" ? sp.saved.slice(0, 300) : null;
  const error = typeof sp.error === "string" ? sp.error.slice(0, 400) : null;
  const answers = await listAnswers();
  const groups = [
    { title: "Used in email replies and on the phone", rows: answers.filter((a) => a.channel === "any") },
    { title: `Used on the phone only (${VOICE_NAME})`, rows: answers.filter((a) => a.channel === "phone") },
  ];
  return (
    <div className="stack">
      <h1>Answers</h1>
      <p className="small muted">
        What we answer when a clinic asks a common question or raises an objection. Reply drafts use the first group; {VOICE_NAME}, the phone
        assistant, uses both and keeps their shape: acknowledge, one fact, one question. Never type a price: use a placeholder, and it is
        filled in from the offer each time ({ANSWER_PLACEHOLDERS.join(", ")}). An answer that promises a result or uses a word such as
        &ldquo;best&rdquo; is not saved.
      </p>
      {saved && <p role="status"><span className="pill pill-ok">{saved}</span></p>}
      {error && <div className="banner banner-warn" role="alert">{error}</div>}
      {groups.map((g) => (
        <section key={g.title} className="stack" aria-label={g.title}>
          <h2>{g.title}</h2>
          {g.rows.length === 0 ? <p className="muted">None.</p> : null}
          {g.rows.map((a) => {
            const shown = expandAnswer(a.answer);
            return (
              <form key={a.id} id={`answer-${a.id}`} action={saveAnswerAction.bind(null, a.id)} className="card stack">
                <label htmlFor={`a-${a.id}`}><strong>{a.question}</strong></label>
                <textarea id={`a-${a.id}`} name="answer" rows={4} maxLength={2000} defaultValue={a.answer} required />
                {shown !== a.answer ? <p className="small muted" style={{ margin: 0 }}>As it is said today: {shown}</p> : null}
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <label htmlFor={`on-${a.id}`} style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
                    <input id={`on-${a.id}`} type="checkbox" name="active" defaultChecked={a.active} /> In use
                  </label>
                  <button className="btn">Save</button>
                </div>
              </form>
            );
          })}
        </section>
      ))}
    </div>
  );
}
