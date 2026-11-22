import { env } from "../env";

/**
 * The few TwiML documents the phone agent returns. One spoken line per
 * response; the caller's reply comes back to `action` as SpeechResult (speech)
 * or Digits (keypad).
 */

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Plain text for a voice: no markup, no control characters, one line. */
export function forSpeech(s: string): string {
  return s
    .replace(/\p{Cc}+/gu, " ")
    .replace(/[*_`#|~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** `voice` is the one chosen in Settings; without it, the environment's (the safe one for error lines). */
function say(text: string, voice?: string): string {
  const e = env();
  return `<Say voice="${xmlEscape(voice || e.VOICE_TTS_VOICE)}" language="${xmlEscape(e.VOICE_LANGUAGE)}">${xmlEscape(forSpeech(text))}</Say>`;
}

const doc = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

/**
 * Say a line and listen. The line sits inside <Gather>, so the caller can
 * speak over it. With nothing heard the action is still called (empty), which
 * is how a silence is noticed.
 */
export function sayAndListen(text: string, actionUrl: string, opts: { hints?: string[]; digits?: number; voice?: string; timeout?: number } = {}): string {
  const e = env();
  const hints = (opts.hints ?? []).map((h) => h.replace(/[,"<>&]/g, " ").trim()).filter(Boolean).slice(0, 40).join(", ");
  const attrs = [
    `input="speech dtmf"`,
    `action="${xmlEscape(actionUrl)}"`,
    `method="POST"`,
    // seconds of silence before the turn is posted empty (how a silence is noticed): 4 by default, more after a question
    `timeout="${Math.min(15, Math.max(2, Math.round(opts.timeout ?? 4)))}"`,
    `speechTimeout="auto"`,
    `language="${xmlEscape(e.VOICE_LANGUAGE)}"`,
    `actionOnEmptyResult="true"`,
    opts.digits ? `numDigits="${opts.digits}"` : "",
    hints ? `hints="${xmlEscape(hints)}"` : "",
  ].filter(Boolean).join(" ");
  return doc(`<Gather ${attrs}>${say(text, opts.voice)}</Gather>`);
}

export function sayAndHangUp(text: string, voice?: string): string {
  return doc(`${say(text, voice)}<Hangup/>`);
}

export function hangUp(): string {
  return doc(`<Hangup/>`);
}

/**
 * The settings voice (a <Say> voice id such as "ElevenLabs.cgSgspJ2msm6clMCkdW9") as ConversationRelay
 * names it: a provider and the provider's own voice id.
 */
export function relayVoice(sayVoice: string): { provider: "ElevenLabs" | "Google" | "Amazon"; voice: string } {
  const dot = sayVoice.indexOf(".");
  const prefix = dot > 0 ? sayVoice.slice(0, dot) : "";
  const id = dot > 0 ? sayVoice.slice(dot + 1) : sayVoice;
  if (prefix === "Google") return { provider: "Google", voice: id };
  if (prefix === "Polly") return { provider: "Amazon", voice: id };
  return { provider: "ElevenLabs", voice: id };
}

export interface RelayTwiml {
  /** wss:// address of our live connection, signed (relayConfig.ts). */
  url: string;
  /** Where the provider asks what to do when the connection ends. */
  actionUrl: string;
  /** The first line, spoken by the provider when the connection opens (the opening of the call). */
  greeting?: string | null;
  /** A line said with <Say> before the connection opens (the last line of a connection that was handed over). */
  before?: string | null;
  voice: string;
  hints?: string[];
  /** Keyed digits are listened for (a caller who may key in a report code). */
  dtmf: boolean;
}

/**
 * Real-time voice: hand the call to Twilio ConversationRelay, which transcribes the caller, speaks
 * our lines and lets the caller interrupt, and exchanges text with us over a live connection.
 * The opening is not interruptible: it is where the caller is told this is an AI and that the call is transcribed.
 */
export function conversationRelay(o: RelayTwiml): string {
  const e = env();
  const v = relayVoice(o.voice);
  const hints = (o.hints ?? []).map((h) => h.replace(/[,"<>&]/g, " ").trim()).filter(Boolean).slice(0, 40).join(", ");
  const attrs = [
    `url="${xmlEscape(o.url)}"`,
    o.greeting ? `welcomeGreeting="${xmlEscape(forSpeech(o.greeting))}"` : "",
    o.greeting ? `welcomeGreetingInterruptible="none"` : "",
    `language="${xmlEscape(e.VOICE_LANGUAGE)}"`,
    `ttsProvider="${v.provider}"`,
    `voice="${xmlEscape(v.voice)}"`,
    `transcriptionProvider="Deepgram"`,
    `interruptible="speech"`,
    `dtmfDetection="${o.dtmf ? "true" : "false"}"`,
    hints ? `hints="${xmlEscape(hints)}"` : "",
    // a dropped connection is reopened by the provider; our side keeps every turn in the database
    `applicationReconnect="true"`,
    `echoPromptFiltering="true"`,
  ].filter(Boolean).join(" ");
  const before = o.before ? say(o.before, o.voice) : "";
  return doc(`${before}<Connect action="${xmlEscape(o.actionUrl)}" method="POST"><ConversationRelay ${attrs}/></Connect>`);
}

export function twimlResponse(xml: string, status = 200): Response {
  return new Response(xml, { status, headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" } });
}
