/**
 * The voices the phone agent can speak in, chosen in Settings > Phone calls.
 *
 * Each one was tried on a real call through Twilio's <Say> before it was
 * listed here (22 November 2026). The ElevenLabs voices sound closest to a
 * person; they are a Twilio public beta, so if one stops working, pick a
 * Google or Amazon voice. Twilio has no Canadian English voice: these are
 * all North American English.
 *
 * Whatever the voice, the agent says at the start of every call that it is
 * an AI assistant. That is in the opening line and in the model's rules, not
 * here, and it does not change with the voice.
 */
export interface CallVoice {
  /** The value of <Say voice="...">. */
  id: string;
  label: string;
}

export const CALL_VOICES: CallVoice[] = [
  { id: "ElevenLabs.cgSgspJ2msm6clMCkdW9", label: "Jessica (ElevenLabs)" },
  { id: "ElevenLabs.EXAVITQu4vr4xnSDxMaL", label: "Sarah (ElevenLabs)" },
  { id: "ElevenLabs.XrExE9yKIg1WjnnlVkGX", label: "Matilda (ElevenLabs)" },
  { id: "ElevenLabs.21m00Tcm4TlvDq8ikWAM", label: "Rachel (ElevenLabs)" },
  { id: "ElevenLabs.FGY2WhTYpPnrIDTdsKH5", label: "Laura (ElevenLabs)" },
  { id: "ElevenLabs.9BWtsMINqrJLrRacOk9x", label: "Aria (ElevenLabs)" },
  { id: "Google.en-US-Chirp3-HD-Aoede", label: "Aoede (Google)" },
  { id: "Polly.Danielle-Generative", label: "Danielle (Amazon), the first voice" },
];

export const DEFAULT_CALL_VOICE = CALL_VOICES[0].id;

export const isCallVoice = (id: string | null | undefined): id is string => CALL_VOICES.some((v) => v.id === id);

/**
 * The voice to speak in: the one chosen in Settings when it is still on the
 * list, otherwise the default. (A line spoken when the settings cannot be
 * read, such as the apology after an error on our side, uses VOICE_TTS_VOICE.)
 */
export function resolveVoice(chosen: string | null | undefined): string {
  return isCallVoice(chosen) ? chosen : DEFAULT_CALL_VOICE;
}
