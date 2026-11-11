import Link from "next/link";
import { SelfServeBox } from "./SelfServeBox";
import { Offers } from "./Offers";
import styles from "./site.module.css";

export default function Home() {
  return (
    <>
      <div className={styles.hero}>
        <div>
          <h1>When patients ask AI, are you in the answer?</h1>
          <p className={styles.lead}>
            Patients now ask AI assistants which dentist, walk-in clinic or medspa to choose. In The Answer asks an
            assistant the questions a patient in your city would ask, records which clinics it names, and shows you
            what on your own website may be standing in the way.
          </p>
          <p>
            <Link className="btn" href="/sample">See a sample report</Link>
          </p>
        </div>
        <div id="get-report"><SelfServeBox /></div>
      </div>

      <section className={styles.section} aria-labelledby="how-h">
        <h2 id="how-h">How it works</h2>
        <div className={styles.grid3}>
          <div className={styles.step}><div className={styles.num}>1</div><h3>We ask</h3><p>Five or six questions, worded the way a patient asks, put to an AI assistant with web search on, from your city.</p></div>
          <div className={styles.step}><div className={styles.num}>2</div><h3>We record</h3><p>Every answer in full: which clinics were recommended, which were only listed, and the sources the assistant used.</p></div>
          <div className={styles.step}><div className={styles.num}>3</div><h3>We check your site</h3><p>Hours, new-patient status, fees, practitioners, booking, speed on a phone, and whether tools can read it. Each finding comes with the page it was seen on.</p></div>
        </div>
        <p style={{ marginTop: 16 }}><Link href="/how-it-works">Read how the test and the checks work</Link></p>
      </section>

      <Offers />

      <section className={styles.section} aria-labelledby="who-h">
        <h2 id="who-h">Who it is for</h2>
        <p className={styles.lead}>
          Independent dental clinics, walk-in and family clinics, and medspas in Ontario that have their own website.
          The free report is yours to keep whether or not you buy anything.
        </p>
      </section>
    </>
  );
}
