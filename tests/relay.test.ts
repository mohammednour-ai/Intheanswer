import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/db";
import { resetEnvForTests } from "@/lib/env";
import { setVoiceProvider, type VoiceProvider } from "@/lib/adapters/voice";
import { setMailProvider } from "@/lib/adapters/mail";
import { conversationRelay, relayVoice } from "@/lib/calls/twiml";
import { relayActionUrl, relayNumbersFrom, relaySocketUrl, relayWanted, verifyRelayKey } from "@/lib/calls/relayConfig";
import { FILLER, RELAY, RelaySession, type RelayDeps, type RelayOut } from "@/lib/calls/relay";
import { noteCutIn, onIncoming, onRelayEnd, parseHandoff, setBrain, setReviewer, takeTurn, type TurnInput, type TurnOutcome } from "@/lib/calls/engine";
import type { AgentTurn, Brain } from "@/lib/calls/agent";
import { resetData } from "./helpers";

const LIVE = {
  OWNER_NAME: "Sam Owner", OWNER_BUSINESS_NAME: "In The Answer Inc.", OWNER_MAILING_ADDRESS: "1 Main St, Barrie ON L4M 1A1", OWNER_PHONE: "705-555-0100",
  TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "12345", TWILIO_PHONE_NUMBER: "+17055550199", ANTHROPIC_API_KEY: "test-key",
  APP_URL: "https://intheanswer.example",
};
const fakeVoice: VoiceProvider = { async placeCall() { return { sid: "CA1" }; }, async endCall() {}, validate: () => true };

function line(say: string, action: AgentTurn["action"] = "continue"): AgentTurn {
  return {
    say, action, stage: "facts", pains: [], buying_signal: false, declined: false, not_decision_maker: false,
    send: null, plan: null, confirmed: false, follow_up_ok: false, handoff_note: null, clinic_search: null, clinic_choice: null,
  };
}
let script: AgentTurn[] = [];
const asked: Parameters<Brain>[0][] = [];
const scriptedBrain: Brain = async (i) => {
  asked.push(i);
  return { turn: script.shift() ?? line("What would you like to know about the service?"), usage: null, costUsd: 0, model: "test" };
};

beforeEach(async () => {
  await resetData();
  Object.assign(process.env, LIVE, { DRY_RUN: "0" });
  resetEnvForTests();
  await db()`update app_settings set dry_run=false, live_enabled=true, calls_enabled=true, call_relay='off', call_relay_numbers='{}' where id`;
  script = []; asked.length = 0;
  setVoiceProvider(fakeVoice);
  setBrain(scriptedBrain);
  setReviewer(async () => ({ review: { summary: "s", outcome: "asked_questions", follow_up: null, unsupported: [], clinic_summary: null }, usage: null, costUsd: 0 }));
  setMailProvider({ async send() { return { id: "re_1" }; }, async getInbound() { throw new Error("unused"); }, async domainState() { return null; }, verifyWebhook() { throw new Error("unused"); } });
});

afterAll(async () => {
  for (const k of [...Object.keys(LIVE), "DRY_RUN"]) delete process.env[k];
  resetEnvForTests();
  setVoiceProvider(null); setBrain(null); setReviewer(null); setMailProvider(null);
  await closeDb();
});

describe("real-time voice: which calls, and the addresses handed to Twilio", () => {
  it("is off unless switched on, and 'listed' matches a number however it was typed", () => {
    expect(relayWanted({ call_relay: "off", call_relay_numbers: ["+16475550101"] }, "+16475550101")).toBe(false);
    expect(relayWanted({ call_relay: null, call_relay_numbers: null }, "+16475550101")).toBe(false);
    expect(relayWanted({ call_relay: "listed", call_relay_numbers: ["+16475550101"] }, "647-555-0101")).toBe(true);
    expect(relayWanted({ call_relay: "listed", call_relay_numbers: ["+16475550101"] }, "+16475550102")).toBe(false);
    expect(relayWanted({ call_relay: "all", call_relay_numbers: [] }, "anything")).toBe(true);
  });

  it("reads the numbers typed in Settings, dropping what is not a number", () => {
    expect(relayNumbersFrom("647-555-0101\n(416) 555 0199, nonsense; 647 555 0101")).toEqual(["+16475550101", "+14165550199"]);
  });

  it("signs the connection address, and refuses any other key", () => {
    const url = new URL(relaySocketUrl("TokenAbcdefghijklmnop"));
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/api/voice/relay/TokenAbcdefghijklmnop");
    expect(verifyRelayKey("TokenAbcdefghijklmnop", url.searchParams.get("k"))).toBe(true);
    expect(verifyRelayKey("OtherTokenabcdefghijk", url.searchParams.get("k"))).toBe(false);
    expect(verifyRelayKey("TokenAbcdefghijklmnop", null)).toBe(false);
    expect(relayActionUrl("TokenAbcdefghijklmnop")).toBe("https://intheanswer.example/api/voice/relay-end/TokenAbcdefghijklmnop");
  });

  it("names the settings voice the way ConversationRelay does", () => {
    expect(relayVoice("ElevenLabs.cgSgspJ2msm6clMCkdW9")).toEqual({ provider: "ElevenLabs", voice: "cgSgspJ2msm6clMCkdW9" });
    expect(relayVoice("Google.en-US-Chirp3-HD-Aoede")).toEqual({ provider: "Google", voice: "en-US-Chirp3-HD-Aoede" });
    expect(relayVoice("Polly.Danielle-Generative")).toEqual({ provider: "Amazon", voice: "Danielle-Generative" });
  });

  it("opens with the greeting, which the caller cannot talk over, and listens for digits only when asked", () => {
    const xml = conversationRelay({ url: "wss://x.example/api/voice/relay/T?k=a&b", actionUrl: "https://x.example/api/voice/relay-end/T", greeting: "Hi, this is Ansa, the AI assistant.", voice: "ElevenLabs.cgSgspJ2msm6clMCkdW9", hints: ["Test Dental", "Growth"], dtmf: true });
    expect(xml).toContain(`<Connect action="https://x.example/api/voice/relay-end/T" method="POST"><ConversationRelay `);
    expect(xml).toContain(`url="wss://x.example/api/voice/relay/T?k=a&amp;b"`);
    expect(xml).toContain(`welcomeGreeting="Hi, this is Ansa, the AI assistant."`);
    expect(xml).toContain(`welcomeGreetingInterruptible="none"`);
    expect(xml).toContain(`ttsProvider="ElevenLabs" voice="cgSgspJ2msm6clMCkdW9"`);
    expect(xml).toContain(`dtmfDetection="true"`);
    expect(xml).toContain(`hints="Test Dental, Growth"`);
    expect(xml).toContain(`applicationReconnect="true"`);
    expect(xml).not.toContain("<Say");
    const next = conversationRelay({ url: "wss://x/r", actionUrl: "https://x/e", before: "Thanks. And the second finding?", voice: "ElevenLabs.cgSgspJ2msm6clMCkdW9", dtmf: false });
    expect(next).toMatch(/<Response><Say voice="ElevenLabs\.cgSgspJ2msm6clMCkdW9"[^>]*>Thanks\. And the second finding\?<\/Say><Connect /);
    expect(next).not.toContain("welcomeGreeting");
    expect(next).toContain(`dtmfDetection="false"`);
  });

  it("reads only the hand-offs it wrote", () => {
    expect(parseHandoff(JSON.stringify({ then: "hangup", say: "Goodbye." }))).toEqual({ then: "hangup", say: "Goodbye." });
    expect(parseHandoff(JSON.stringify({ then: "continue" }))).toEqual({ then: "continue", say: null });
    expect(parseHandoff("{bad")).toBeNull();
    expect(parseHandoff(JSON.stringify({ then: "dial" }))).toBeNull();
    expect(parseHandoff(null)).toBeNull();
  });
});

/** A session with a clock and timers the test moves by hand, and a scripted turn. */
function harness(outcomes: (TurnOutcome | Error | { wait: number; then: TurnOutcome })[] = []) {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const sent: RelayOut[] = [];
  const inputs: TurnInput[] = [];
  const cuts: string[] = [];
  const order: string[] = [];
  const deps: RelayDeps = {
    now: () => now,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    noteCutIn: async (_t, heard) => { cuts.push(heard); order.push(`cut:${heard}`); },
    takeTurn: async (_t, input) => {
      inputs.push(input);
      order.push(`turn:${input.speech ?? input.digits ?? "(silence)"}`);
      const o = outcomes.shift() ?? say("Anything else?");
      if (o instanceof Error) throw o;
      if ("wait" in o) { advance(o.wait); return o.then; }
      return o;
    },
  };
  function advance(ms: number) {
    const until = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > until) break;
      timers.shift();
      now = t.at;
      t.fn();
    }
    now = until;
  }
  const session = new RelaySession("TokenAbcdefghijklmnop", (m) => sent.push(m), deps);
  const prompt = (text: string, last = true) => session.handle(JSON.stringify({ type: "prompt", voicePrompt: text, lang: "en-US", last }));
  return { session, sent, inputs, cuts, order, advance, prompt, timers, settle: () => session.idle };
}
function say(lineText: string, action: AgentTurn["action"] = "continue", listen: Partial<{ hints: string[]; digits: number; timeout: number }> = {}): TurnOutcome {
  return { kind: "say", line: lineText, action, voice: "ElevenLabs.cgSgspJ2msm6clMCkdW9", listen: { hints: ["Test Dental"], timeout: 4, ...listen } };
}
const texts = (sent: RelayOut[]) => sent.flatMap((m) => (m.type === "text" ? [m.token] : []));
const ends = (sent: RelayOut[]) => sent.flatMap((m) => (m.type === "end" ? [JSON.parse(m.handoffData)] : []));

describe("real-time voice: one live connection", () => {
  it("answers a finished utterance with one line, and sends the recognition hints once", async () => {
    const h = harness([say("The headline is that Test Dental was recommended in 2 of the 6 answers."), say("The second question asked about emergencies.")]);
    await h.prompt("What did you find?");
    await h.prompt("And the second one?");
    expect(h.inputs).toEqual([{ speech: "What did you find?" }, { speech: "And the second one?" }]);
    expect(texts(h.sent)).toEqual(["The headline is that Test Dental was recommended in 2 of the 6 answers.", "The second question asked about emergencies."]);
    expect(h.sent.filter((m) => m.type === "hints")).toEqual([{ type: "hints", hints: "Test Dental" }]);
    expect(h.sent.find((m) => m.type === "text")).toMatchObject({ last: true });
  });

  it("skips a partial transcript and anything that is not a message", async () => {
    const h = harness();
    await h.prompt("What did", false);
    await h.session.handle("not json");
    await h.session.handle(JSON.stringify({ type: "setup", callSid: "CA1" }));
    expect(h.inputs).toEqual([]);
  });

  it("times a silence itself after the line has had time to be said, and runs the silence turn", async () => {
    const h = harness([say("Shall I go through the questions?", "continue", { timeout: 6 }), say("Are you still there?")]);
    await h.prompt("Hello?");
    const wait = "Shall I go through the questions?".length * RELAY.msPerChar + 6000;
    h.advance(wait - 10);
    await h.settle();
    expect(h.inputs).toHaveLength(1);
    h.advance(20);
    await h.settle();
    expect(h.inputs[1]).toEqual({ speech: null });
    expect(texts(h.sent).at(-1)).toBe("Are you still there?");
  });

  it("does not count a silence while the caller is speaking or keying", async () => {
    const h = harness([say("Shall I go on?"), say("Sure.")]);
    await h.prompt("Hello?");
    h.advance(3000);
    await h.prompt("Yes please.");
    h.advance(RELAY.msPerChar * 10);
    await h.settle();
    expect(h.inputs.map((i) => i.speech)).toEqual(["Hello?", "Yes please."]);
  });

  it("ends the connection to hang up, carrying the last line, which the action route says", async () => {
    const h = harness([say("Understood. We won't call this number again. Goodbye.", "do_not_call")]);
    await h.prompt("Don't call me again.");
    expect(texts(h.sent)).toEqual([]);
    expect(ends(h.sent)).toEqual([{ then: "hangup", say: "Understood. We won't call this number again. Goodbye." }]);
    expect(h.session.isEnded).toBe(true);
    await h.prompt("Hello?");
    expect(h.inputs).toHaveLength(1);
  });

  it("hangs up without a word when the turn says so (an answering machine)", async () => {
    const h = harness([{ kind: "hangup" }]);
    await h.prompt("Please leave a message after the tone.");
    expect(ends(h.sent)).toEqual([{ then: "hangup" }]);
  });

  it("says 'One moment.' when a reply is slow, but never on two turns in a row", async () => {
    const slow = (t: string) => ({ wait: RELAY.fillerAfterMs + 500, then: say(t) });
    const h = harness([slow("First."), slow("Second."), slow("Third.")]);
    await h.prompt("One");
    await h.prompt("Two");
    await h.prompt("Three");
    expect(texts(h.sent)).toEqual([FILLER, "First.", "Second.", FILLER, "Third."]);
  });

  it("says nothing extra when the reply is quick", async () => {
    const h = harness([{ wait: RELAY.fillerAfterMs - 100, then: say("Quick.") }]);
    await h.prompt("Hi");
    expect(texts(h.sent)).toEqual(["Quick."]);
  });

  it("hands the call to a new connection before the host's time limit, with the line to say", async () => {
    // a long listening time, so the silence check does not fire while the clock is moved on
    const h = harness([say("Early.", "continue", { timeout: 1000 }), say("Late line.")]);
    await h.prompt("One");
    h.advance(RELAY.handoverAfterMs + 1000);
    await h.prompt("Two");
    expect(texts(h.sent)).toEqual(["Early."]);
    expect(ends(h.sent)).toEqual([{ then: "continue", say: "Late line." }]);
  });

  it("answers what the caller said while a turn was being worked out in one reply", async () => {
    const h = harness([{ wait: 500, then: say("First reply.") }, say("Reply to both.")]);
    const first = h.prompt("Tell me the result.");
    void h.prompt("Actually,");
    void h.prompt("start with the price.");
    await first;
    await h.settle();
    expect(h.inputs).toEqual([{ speech: "Tell me the result." }, { speech: "Actually, start with the price." }]);
  });

  it("collects a keyed report code: six digits at once, or what came before a pause", async () => {
    const h = harness([say("Thanks, I have the report.", "continue", { digits: 6 }), say("Got it.", "continue", { digits: 6 })]);
    for (const d of "123456") await h.session.handle(JSON.stringify({ type: "dtmf", digit: d }));
    await h.settle();
    expect(h.inputs[0]).toEqual({ digits: "123456" });
    for (const d of "12") await h.session.handle(JSON.stringify({ type: "dtmf", digit: d }));
    h.advance(RELAY.digitPauseMs + 1);
    await h.settle();
    expect(h.inputs[1]).toEqual({ digits: "12" });
  });

  it("ignores keyed digits once no code is wanted", async () => {
    const h = harness([say("I have the report for Test Dental.", "continue", {})]);
    await h.prompt("It's Test Dental in Barrie.");
    for (const d of "123456") await h.session.handle(JSON.stringify({ type: "dtmf", digit: d }));
    await h.settle();
    expect(h.inputs).toHaveLength(1);
  });

  it("notes what the caller had heard when they cut in, before their words are answered", async () => {
    const h = harness([say("The first finding is a broken link on the about page."), say("Sure, the price.")]);
    await h.prompt("Hi");
    await h.session.handle(JSON.stringify({ type: "interrupt", utteranceUntilInterrupt: "The first finding is", durationUntilInterruptMs: 900 }));
    await h.prompt("What does it cost?");
    expect(h.order).toEqual(["turn:Hi", "cut:The first finding is", "turn:What does it cost?"]);
  });

  it("apologises and hangs up if a turn fails on our side", async () => {
    const h = harness([new Error("database down")]);
    await h.prompt("Hello?");
    const [end] = ends(h.sent);
    expect(end.then).toBe("hangup");
    expect(end.say).toMatch(/something went wrong on our side/);
  });

  it("stops its timers when the connection closes", async () => {
    const h = harness([say("Shall I go on?")]);
    await h.prompt("Hello?");
    expect(h.timers.length).toBeGreaterThan(0);
    h.session.close();
    expect(h.timers).toHaveLength(0);
  });
});

describe("real-time voice: the engine's side", () => {
  const OWNER = "+16475550101";

  it("hands a listed caller's call to the live connection, with the same opening on record", async () => {
    await db()`update app_settings set call_relay='listed', call_relay_numbers=${[OWNER]} where id`;
    const xml = await onIncoming({ callSid: "CArelay1", from: OWNER });
    expect(xml).toContain("<ConversationRelay ");
    expect(xml).toMatch(/welcomeGreeting="Hi, this is Ansa, the AI assistant from In The Answer\. This call is transcribed/);
    expect(xml).toContain(`dtmfDetection="true"`);
    const [c] = await db()<{ id: string; token: string }[]>`select id, token from calls where provider_call_sid='CArelay1'`;
    expect(xml).toContain(relaySocketUrl(c.token).replace("&", "&amp;"));
    const [first] = await db()<{ role: string; text: string; fixed: boolean }[]>`select role, text, fixed from call_turns where call_id=${c.id} order by seq`;
    expect(first).toMatchObject({ role: "agent", fixed: true });
    // anyone else keeps the standard line
    const other = await onIncoming({ callSid: "CArelay2", from: "+14165550123" });
    expect(other).toContain("<Gather ");
    expect(other).not.toContain("ConversationRelay");
  });

  it("runs a turn the same way for both paths, and tells the model what a cut-in caller had heard, once", async () => {
    await onIncoming({ callSid: "CArelay3", from: OWNER });
    const [c] = await db()<{ id: string; token: string }[]>`select id, token from calls where provider_call_sid='CArelay3'`;
    script = [line("We test whether AI assistants recommend local clinics."), line("It starts at 200 dollars a month.")];
    const o = await takeTurn(c.token, { speech: "What do you do?" });
    expect(o).toMatchObject({ kind: "say", line: "We test whether AI assistants recommend local clinics.", action: "continue" });
    await noteCutIn(c.token, "We test whether");
    await takeTurn(c.token, { speech: "How much is it?" });
    await takeTurn(c.token, { speech: "OK." });
    expect(asked.map((a) => a.cutIn ?? null)).toEqual([null, "We test whether", null]);
    const notes = await db()<{ text: string }[]>`select text from call_turns where call_id=${c.id} and role='system'`;
    expect(notes.map((n) => n.text)).toContain(`The caller cut in after hearing: "We test whether"`);
  });

  it("after the live connection: says the last line and hangs up, or opens a new connection", async () => {
    await onIncoming({ callSid: "CArelay4", from: OWNER });
    const [c] = await db()<{ token: string }[]>`select token from calls where provider_call_sid='CArelay4'`;
    const bye = await onRelayEnd(c.token, { handoff: JSON.stringify({ then: "hangup", say: "Thanks for calling. Goodbye." }), callStatus: "in-progress" });
    expect(bye).toMatch(/<Say [^>]*>Thanks for calling\. Goodbye\.<\/Say><Hangup\/>/);
    const next = await onRelayEnd(c.token, { handoff: JSON.stringify({ then: "continue", say: "And the second question?" }), callStatus: "in-progress" });
    expect(next).toMatch(/<Say [^>]*>And the second question\?<\/Say><Connect /);
    expect(next).not.toContain("welcomeGreeting");
    expect(await onRelayEnd(c.token, { handoff: null, callStatus: "completed" })).toContain("<Hangup/>");
  });

  it("when the live connection fails, the call carries on over the standard line", async () => {
    await onIncoming({ callSid: "CArelay5", from: OWNER });
    const [c] = await db()<{ id: string; token: string }[]>`select id, token from calls where provider_call_sid='CArelay5'`;
    const xml = await onRelayEnd(c.token, { handoff: null, callStatus: "in-progress", sessionStatus: "failed", errorCode: "64102", errorMessage: "Unable to connect" });
    expect(xml).toContain("<Gather ");
    expect(xml).toContain(`/api/voice/turn/${c.token}`);
    expect(xml).toContain("Sorry, I missed that. Could you say it again?");
    const [row] = await db()<{ state: { relayFailed?: boolean } }[]>`select state from calls where id=${c.id}`;
    expect(row.state.relayFailed).toBe(true);
    const notes = await db()<{ text: string }[]>`select text from call_turns where call_id=${c.id} and role='system'`;
    expect(notes[0].text).toMatch(/real-time connection ended unexpectedly \(failed 64102 Unable to connect\)/);
  });
});
