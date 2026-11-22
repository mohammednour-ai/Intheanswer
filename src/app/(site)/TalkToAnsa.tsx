import { VOICE_NAME, copilotAvatarSvg } from "@/lib/brand";
import { displayPhone } from "@/lib/calls/phone";
import { env, ownerDetails } from "@/lib/env";
import t from "./talk.module.css";

/** A phone handset, drawn in the current text colour. */
function Handset({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 4h3.2l1.6 4-2 1.3a11 11 0 0 0 6.9 6.9l1.3-2 4 1.6V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
    </svg>
  );
}

/** The answer mark stood on end as a voice: grey bars either side of one tall blue bar. Static, it never moves. */
const WAVE = [10, 18, 26, 14, 34, 52, 34, 14, 26, 18, 10];
function Voice() {
  const w = WAVE.length * 10 - 4;
  return (
    <svg className={t.voice} width={w} height="52" viewBox={`0 0 ${w} 52`} aria-hidden="true">
      {WAVE.map((h, i) => (
        <rect key={i} x={i * 10} y={(52 - h) / 2} width="6" height={h} rx="3" className={h === 52 ? t.voiceMain : t.voiceSide} />
      ))}
    </svg>
  );
}

/**
 * "Talk to Ansa": a button that stays in the bottom corner of every public page and opens a small card
 * with our phone number. Ansa, the AI assistant, answers that number (src/lib/calls/engine.ts, onIncoming).
 * It uses the browser's popover, so it needs no script, closes on Escape or a tap outside, and nothing moves.
 * Shown only when the phone number is configured.
 */
export function TalkToAnsa() {
  const number = env().TWILIO_PHONE_NUMBER;
  if (!number) return null;
  const o = ownerDetails();
  const shown = displayPhone(number);
  return (
    <>
      <button type="button" className={t.dock} popoverTarget="talk-to-ansa" aria-haspopup="dialog">
        <span className={t.dockAvatar} dangerouslySetInnerHTML={{ __html: copilotAvatarSvg({ size: 40 }) }} />
        <span className={t.dockText}>
          <span className={t.dockTitle}>Talk to {VOICE_NAME}</span>
          <span className={t.dockSub}>Our AI assistant · {shown}</span>
        </span>
        <span className={t.dockCall}><Handset size={18} /></span>
      </button>

      <div id="talk-to-ansa" popover="auto" role="dialog" aria-labelledby="talk-to-ansa-h" className={t.panel}>
        <div className={t.head}>
          <span dangerouslySetInnerHTML={{ __html: copilotAvatarSvg({ size: 56, variant: "light" }) }} />
          <div className={t.headText}>
            <span id="talk-to-ansa-h" className={t.name}>{VOICE_NAME}</span>
            <span className={t.role}>AI assistant · In The Answer</span>
          </div>
          <button type="button" className={t.close} popoverTarget="talk-to-ansa" popoverTargetAction="hide" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12" /><path d="M18 6L6 18" /></svg>
          </button>
        </div>

        <div className={t.body}>
          <div className={t.greeting}>
            <Voice />
            <p className={t.quote}>&ldquo;Hi, this is {VOICE_NAME}, the AI assistant from In The Answer.&rdquo;</p>
            <span className={t.caption}>How every call starts</span>
          </div>

          <ul className={t.asks}>
            <li>What your clinic&rsquo;s report found</li>
            <li>The plans and what they cost</li>
            <li>How we work with a clinic</li>
          </ul>

          <a className={t.call} href={`tel:${number}`}>
            <Handset />
            Call {shown}
          </a>

          <p className={t.fine}>
            {VOICE_NAME} says it is an AI. The call is transcribed so our team can review it. Prefer a person?{" "}
            <a href={`mailto:${o.email}`}>{o.email}</a>
          </p>
        </div>
      </div>
    </>
  );
}
