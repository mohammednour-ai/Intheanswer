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

function say(text: string): string {
  const e = env();
  return `<Say voice="${xmlEscape(e.VOICE_TTS_VOICE)}" language="${xmlEscape(e.VOICE_LANGUAGE)}">${xmlEscape(forSpeech(text))}</Say>`;
}

const doc = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

/**
 * Say a line and listen. The line sits inside <Gather>, so the caller can
 * speak over it. With nothing heard the action is still called (empty), which
 * is how a silence is noticed.
 */
export function sayAndListen(text: string, actionUrl: string, opts: { hints?: string[]; digits?: number } = {}): string {
  const e = env();
  const hints = (opts.hints ?? []).map((h) => h.replace(/[,"<>&]/g, " ").trim()).filter(Boolean).slice(0, 40).join(", ");
  const attrs = [
    `input="speech dtmf"`,
    `action="${xmlEscape(actionUrl)}"`,
    `method="POST"`,
    `timeout="6"`,
    `speechTimeout="auto"`,
    `language="${xmlEscape(e.VOICE_LANGUAGE)}"`,
    `actionOnEmptyResult="true"`,
    opts.digits ? `numDigits="${opts.digits}"` : "",
    hints ? `hints="${xmlEscape(hints)}"` : "",
  ].filter(Boolean).join(" ");
  return doc(`<Gather ${attrs}>${say(text)}</Gather>`);
}

export function sayAndHangUp(text: string): string {
  return doc(`${say(text)}<Hangup/>`);
}

export function hangUp(): string {
  return doc(`<Hangup/>`);
}

export function twimlResponse(xml: string, status = 200): Response {
  return new Response(xml, { status, headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" } });
}
