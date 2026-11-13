import type { Metadata } from "next";
import styles from "../site.module.css";

export const metadata: Metadata = {
  title: "About our crawler",
  description: "InTheAnswerBot reads public clinic websites to prepare reports. It respects robots.txt, reads slowly and can be blocked.",
};

export default function Bot() {
  return (
    <div className="wrap">
      <article className={styles.prose}>
      <h1>About our crawler</h1>
      <p><code>InTheAnswerBot</code> reads the public websites of Ontario clinics to prepare a report for that clinic about its own site.</p>
      <ul>
        <li>It follows robots.txt. To keep it out, add <code>User-agent: InTheAnswerBot</code> and <code>Disallow: /</code>.</li>
        <li>It makes one request every few seconds and reads at most 40 pages per site.</li>
        <li>It reads only public pages. It does not log in, submit forms or book appointments.</li>
      </ul>
      <p>Questions: <a href="mailto:hello@intheanswer.ca">hello@intheanswer.ca</a>.</p>
    </article>
    </div>
  );
}
