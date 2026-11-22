import { ownerDetails } from "../env";
import { forSpeech } from "./twiml";
import { noteCutIn, takeTurn, type RelayHandoff, type TurnInput, type TurnOutcome } from "./engine";

/**
 * Real-time voice: one live connection with Twilio ConversationRelay.
 *
 * Twilio transcribes the caller and speaks our text; we answer each finished utterance with the
 * same turn the HTTP path runs (engine.ts `takeTurn`), so the script, the spoken-word check, the
 * playbook and the records are the same on both paths. What only this path needs is here:
 *
 *   - one turn at a time: what the caller says while a turn is being worked out joins the next one;
 *   - "One moment." when a reply takes a while, never twice in a row;
 *   - silence: Twilio sends nothing while the caller is silent, so we time it ourselves after each line
 *     and run the same silence turn as the HTTP path ("Are you still there?", then goodbye);
 *   - keyed digits (a report code) are collected until six have come or the caller pauses;
 *   - an interruption is noted, and the model told what the caller had actually heard;
 *   - a line that ends the call, and the hand-over to a new connection before the host's time limit
 *     for one connection, go back to Twilio as an "end" message: the <Connect action> route
 *     (engine.ts `onRelayEnd`) says the line with <Say> and hangs up, or opens a new connection.
 *
 * The class knows nothing of sockets or timers it is not given, so it is tested without a network.
 */

/** Messages we send to ConversationRelay. */
export type RelayOut =
  | { type: "text"; token: string; last: boolean }
  | { type: "hints"; hints: string }
  | { type: "end"; handoffData: string };

export interface RelayDeps {
  takeTurn: (token: string, input: TurnInput) => Promise<TurnOutcome>;
  noteCutIn: (token: string, heardPart: string) => Promise<void>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
}

export const RELAY = {
  /**
   * A reply slower than this gets "One moment." first. Most replies take 1.5 to 2.2 seconds on
   * production (22 November 2026): at 1.8 the filler often came a fifth of a second before the answer.
   */
  fillerAfterMs: 2500,
  /**
   * A connection older than this is handed over to a new one at the next line. Vercel closes a
   * function's connection at its maximum duration (300 seconds on the Hobby plan): this leaves room
   * for one slow turn before that.
   */
  handoverAfterMs: 220_000,
  /** Keyed digits: the code is taken when the caller stops keying for this long. */
  digitPauseMs: 4000,
  /** Roughly how long a line takes to say, per character, before the silence clock starts. */
  msPerChar: 70,
};

export const FILLER = "One moment.";

export const defaultRelayDeps = (): RelayDeps => ({
  takeTurn, noteCutIn,
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
});

type Pending = { kind: "turn"; input: TurnInput } | { kind: "cut"; heard: string };

export class RelaySession {
  private readonly openedAt: number;
  private pending: Pending[] = [];
  private busy = false;
  private ended = false;
  private silence: unknown = null;
  private digitTimer: unknown = null;
  private digits = "";
  private wantDigits = true;
  private lastHints: string | null = null;
  private fillerLastTurn = false;
  /** Resolves when the queue is empty (tests wait on it). */
  idle: Promise<void> = Promise.resolve();

  constructor(private readonly token: string, private readonly send: (m: RelayOut) => void, private readonly deps: RelayDeps = defaultRelayDeps()) {
    this.openedAt = deps.now();
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** One message from ConversationRelay. Never throws: a bad message is ignored. */
  handle(raw: string): Promise<void> {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return this.idle;
    }
    if (this.ended) return this.idle;
    switch (m.type) {
      case "prompt":
        // with partial prompts off every prompt is final; a partial one (last: false) is skipped
        if (m.last === false) return this.idle;
        this.stopSilence();
        return this.push({ kind: "turn", input: { speech: String(m.voicePrompt ?? "") } });
      case "dtmf":
        this.stopSilence();
        return this.onDigit(String(m.digit ?? ""));
      case "interrupt":
        this.stopSilence();
        return this.push({ kind: "cut", heard: String(m.utteranceUntilInterrupt ?? "") });
      case "error":
        console.warn("conversation relay error", String(m.description ?? "").slice(0, 300));
        return this.idle;
      default:
        // setup (the opening is already said and recorded), info: nothing to do
        return this.idle;
    }
  }

  /** The connection closed (by Twilio, by us, or by the host): stop everything still pending. */
  close(): void {
    this.ended = true;
    this.pending = [];
    this.stopSilence();
    if (this.digitTimer) this.deps.clearTimer(this.digitTimer);
    this.digitTimer = null;
  }

  private push(p: Pending): Promise<void> {
    this.pending.push(p);
    if (!this.busy) this.idle = this.drain();
    return this.idle;
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (this.pending.length && !this.ended) {
        const batch = this.pending.splice(0);
        for (const p of batch) if (p.kind === "cut") await this.deps.noteCutIn(this.token, p.heard).catch((e) => console.error("relay cut-in note failed", e));
        const turns = batch.flatMap((p) => (p.kind === "turn" ? [p.input] : []));
        if (turns.length) await this.runTurn(merge(turns));
      }
    } finally {
      this.busy = false;
    }
  }

  private async runTurn(input: TurnInput): Promise<void> {
    let fillerSaid = false;
    let filler: unknown = this.fillerLastTurn ? null : this.deps.setTimer(() => {
      filler = null;
      if (this.ended) return;
      fillerSaid = true;
      this.send({ type: "text", token: FILLER, last: true });
    }, RELAY.fillerAfterMs);
    let o: TurnOutcome;
    try {
      o = await this.deps.takeTurn(this.token, input);
    } catch (e) {
      console.error("relay turn failed", e);
      return this.end({ then: "hangup", say: `I am sorry, something went wrong on our side. ${ownerDetails().name} will follow up with you. Goodbye.` });
    } finally {
      if (filler) this.deps.clearTimer(filler);
    }
    this.fillerLastTurn = fillerSaid;
    if (this.ended) return;
    if (o.kind === "hangup") return this.end({ then: "hangup" });
    if (o.action !== "continue") return this.end({ then: "hangup", say: o.line });
    // near the host's limit for one connection: say this line from TwiML and open a new connection
    if (this.deps.now() - this.openedAt > RELAY.handoverAfterMs) return this.end({ then: "continue", say: o.line });
    this.wantDigits = !!o.listen.digits;
    const hints = o.listen.hints.join(", ");
    if (hints !== this.lastHints) {
      this.lastHints = hints;
      if (hints) this.send({ type: "hints", hints });
    }
    const line = forSpeech(o.line);
    this.send({ type: "text", token: line, last: true });
    this.startSilence(line, o.listen.timeout);
  }

  private end(h: RelayHandoff): void {
    if (this.ended) return;
    this.close();
    this.send({ type: "end", handoffData: JSON.stringify(h) });
  }

  /** Twilio reports no silence: after a line has had time to be said, wait the listening time, then run the silence turn. */
  private startSilence(line: string, timeoutSeconds: number): void {
    this.stopSilence();
    this.silence = this.deps.setTimer(() => {
      this.silence = null;
      if (!this.ended) void this.push({ kind: "turn", input: { speech: null } });
    }, line.length * RELAY.msPerChar + timeoutSeconds * 1000);
  }

  private stopSilence(): void {
    if (this.silence) this.deps.clearTimer(this.silence);
    this.silence = null;
  }

  private onDigit(d: string): Promise<void> {
    if (!this.wantDigits || !/^[0-9#*]$/.test(d)) return this.idle;
    if (this.digitTimer) this.deps.clearTimer(this.digitTimer);
    this.digitTimer = null;
    if (d !== "#" && d !== "*") this.digits += d;
    if (d === "#" || this.digits.length >= 6) return this.flushDigits();
    this.digitTimer = this.deps.setTimer(() => {
      this.digitTimer = null;
      void this.flushDigits();
    }, RELAY.digitPauseMs);
    return this.idle;
  }

  private flushDigits(): Promise<void> {
    const digits = this.digits;
    this.digits = "";
    if (!digits || this.ended) return this.idle;
    return this.push({ kind: "turn", input: { digits } });
  }
}

/** What the caller said while a turn was being worked out is answered together: one reply, not several. */
function merge(inputs: TurnInput[]): TurnInput {
  const speech = inputs.map((i) => (i.speech ?? "").trim()).filter(Boolean).join(" ");
  const digits = [...inputs].reverse().find((i) => i.digits)?.digits ?? null;
  if (digits && !speech) return { digits };
  return { speech: speech || null };
}
