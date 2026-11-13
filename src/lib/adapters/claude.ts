import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { env } from "../env";
import { withRecording } from "./recorder";

/**
 * Claude API adapter. Model and request shapes follow the current API:
 * - model from CLAUDE_MODEL (default claude-opus-5-5); thinking is always on for
 *   this model, depth is set with output_config.effort
 * - web search tool web_search_20260209 with an approximate user location
 * - server-side refusal fallback (beta) so a declined request is retried on the
 *   fallback model; the model that actually answered is recorded
 * - structured outputs via messages.parse + zodOutputFormat
 * - pause_turn is resumed by re-sending the assistant content
 */

export const ASSISTANT_NAME = "Claude";

/** USD prices. Check https://docs.claude.com pricing before changing CLAUDE_MODEL. */
const PRICES: Record<string, { in: number; out: number; cacheRead: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
  "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { in: 5, out: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01 },
};
/** Web search is billed per search on top of tokens. Confirm current price in the Claude docs. */
export const WEB_SEARCH_USD_PER_SEARCH = 0.01;

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null;
}

export function costUsd(model: string, u: UsageLike): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5-5"];
  const tokens =
    (u.input_tokens * p.in + (u.cache_creation_input_tokens ?? 0) * p.in * 1.25 + (u.cache_read_input_tokens ?? 0) * p.cacheRead + u.output_tokens * p.out) /
    1e6;
  return tokens + (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD_PER_SEARCH;
}

function addUsage(a: UsageLike, b: UsageLike): UsageLike {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    server_tool_use: {
      web_search_requests: (a.server_tool_use?.web_search_requests ?? 0) + (b.server_tool_use?.web_search_requests ?? 0),
      web_fetch_requests: (a.server_tool_use?.web_fetch_requests ?? 0) + (b.server_tool_use?.web_fetch_requests ?? 0),
    },
  };
}

const ZERO: UsageLike = { input_tokens: 0, output_tokens: 0 };

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    const key = env().ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
    client = new Anthropic({ apiKey: key, baseURL: "https://api.anthropic.com", maxRetries: 3 });
  }
  return client;
}

/** What a failed call still cost: the tokens are billed whether or not the answer is usable. */
export interface CallSpend {
  usage: UsageLike;
  costUsd: number;
  servedModel: string;
}

/** The request was declined (stop_reason "refusal"), by the model and by the fallback if one ran. */
export class ClaudeRefusalError extends Error {
  constructor(message: string, public readonly spend: CallSpend | null = null) {
    super(message);
    this.name = "ClaudeRefusalError";
  }
}

/**
 * The call returned, but not a complete answer: cut off at max_tokens or the
 * context window, a paused turn that never resumed to an end, or no text.
 * Such a response must never be stored or read as an answer.
 */
export class ClaudeIncompleteError extends Error {
  constructor(message: string, public readonly reason: string, public readonly spend: CallSpend | null = null) {
    super(message);
    this.name = "ClaudeIncompleteError";
  }
}

/** Stop reasons that mean the model finished what it had to say. */
const COMPLETE_STOP_REASONS = new Set(["end_turn", "stop_sequence"]);

// ---------------------------------------------------------------------------
// Patient question with web search
// ---------------------------------------------------------------------------

export interface AnswerSource {
  url: string;
  title: string | null;
  cited: boolean;
}

export interface PatientAnswer {
  text: string;
  sources: AnswerSource[];
  citations: { url: string; title: string | null; cited_text: string }[];
  requestedModel: string;
  servedModel: string;
  stopReason: string | null;
  usage: UsageLike;
  costUsd: number;
  askedAt: string;
}

interface Block {
  type: string;
  text?: string;
  citations?: { type: string; url?: string; title?: string | null; cited_text?: string }[] | null;
  content?: unknown;
}

export function extractAnswer(blocks: Block[]): Pick<PatientAnswer, "text" | "sources" | "citations"> {
  const sources = new Map<string, AnswerSource>();
  const citations: PatientAnswer["citations"] = [];
  let text = "";
  for (const b of blocks) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content as { type: string; url: string; title: string }[]) {
        if (r.type === "web_search_result" && !sources.has(r.url)) sources.set(r.url, { url: r.url, title: r.title ?? null, cited: false });
      }
    }
    if (b.type === "text" && b.text) {
      text += b.text;
      for (const c of b.citations ?? []) {
        if (c.url) {
          citations.push({ url: c.url, title: c.title ?? null, cited_text: c.cited_text ?? "" });
          const s = sources.get(c.url) ?? { url: c.url, title: c.title ?? null, cited: true };
          s.cited = true;
          sources.set(c.url, s);
        }
      }
    }
  }
  return { text: text.trim(), sources: [...sources.values()], citations };
}

/**
 * Ask a question exactly as a patient would: no system prompt, no hint about
 * any clinic, web search on, located in the city.
 */
export async function askPatientQuestion(question: string, city: string): Promise<PatientAnswer> {
  const model = env().CLAUDE_MODEL;
  const effort = env().CLAUDE_EFFORT;
  return withRecording("claude-ask", { model, effort, question, city }, async () => {
    const tools = [
      {
        type: "web_search_20260209" as const,
        name: "web_search" as const,
        max_uses: 5,
        user_location: { type: "approximate" as const, city, region: "Ontario", country: "CA", timezone: "America/Toronto" },
      },
    ];
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: question }];
    let usage = ZERO;
    let allBlocks: Block[] = [];
    let servedModel = model;
    let stopReason: string | null = null;
    for (let turn = 0; turn < 5; turn++) {
      const res = await anthropic().beta.messages
        .create({
          model,
          max_tokens: 16000,
          output_config: { effort },
          tools,
          messages,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        })
        .catch((e: unknown) => {
          // a resume failed after earlier turns of this answer were billed: keep what they cost
          if (turn === 0) throw e;
          throw new ClaudeIncompleteError(`answer not complete (${e instanceof Error ? e.message : String(e)})`.slice(0, 300), "error_after_pause", {
            usage, costUsd: costUsd(servedModel, usage), servedModel,
          });
        });
      usage = addUsage(usage, res.usage as UsageLike);
      servedModel = res.model;
      stopReason = res.stop_reason;
      allBlocks = allBlocks.concat(res.content as unknown as Block[]);
      if (res.stop_reason === "refusal") {
        throw new ClaudeRefusalError(`refused: ${JSON.stringify(res.stop_details ?? null)}`, { usage, costUsd: costUsd(servedModel, usage), servedModel });
      }
      if (res.stop_reason !== "pause_turn") break;
      // resume: send the assistant content back unchanged, no extra user message
      if (turn === 0) messages.push({ role: "assistant", content: res.content as never });
      else messages[messages.length - 1] = { role: "assistant", content: allBlocks as never };
    }
    const spend: CallSpend = { usage, costUsd: costUsd(servedModel, usage), servedModel };
    // Anything but a finished turn is not an answer: max_tokens, a context
    // window overflow, or a pause_turn still unresolved after the resumes above.
    if (!stopReason || !COMPLETE_STOP_REASONS.has(stopReason)) {
      throw new ClaudeIncompleteError(`answer not complete (stop_reason ${stopReason ?? "none"})`, stopReason ?? "none", spend);
    }
    const ex = extractAnswer(allBlocks);
    if (!ex.text) throw new ClaudeIncompleteError("answer has no text", "empty", spend);
    return {
      ...ex,
      requestedModel: model,
      servedModel,
      stopReason,
      usage,
      costUsd: costUsd(servedModel, usage),
      askedAt: new Date().toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Structured analysis (no tools)
// ---------------------------------------------------------------------------

export interface Structured<T> {
  data: T;
  usage: UsageLike;
  costUsd: number;
  model: string;
}

export async function structured<S extends z.ZodType>(opts: {
  purpose: string; // recording namespace + logging
  system: string;
  user: string;
  schema: S;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
}): Promise<Structured<z.infer<S>>> {
  const model = env().CLAUDE_MODEL;
  const effort = opts.effort ?? "medium";
  return withRecording(`claude-${opts.purpose}`, { model, effort, system: opts.system, user: opts.user }, async () => {
    const res = await anthropic().messages.parse({
      model,
      max_tokens: opts.maxTokens ?? 16000,
      system: opts.system,
      output_config: { effort, format: zodOutputFormat(opts.schema) },
      messages: [{ role: "user", content: opts.user }],
    });
    const usage = res.usage as unknown as UsageLike;
    const spend: CallSpend = { usage, costUsd: costUsd(res.model, usage), servedModel: res.model };
    if (res.stop_reason === "refusal") throw new ClaudeRefusalError(`refused during ${opts.purpose}`, spend);
    if (res.stop_reason === "max_tokens" || res.stop_reason === "model_context_window_exceeded" || res.stop_reason === "pause_turn") {
      throw new ClaudeIncompleteError(`${opts.purpose}: output not complete (${res.stop_reason})`, res.stop_reason, spend);
    }
    if (!res.parsed_output) throw new ClaudeIncompleteError(`${opts.purpose}: no parsed output`, "no_parsed_output", spend);
    return { data: res.parsed_output as z.infer<S>, usage, costUsd: costUsd(res.model, usage), model: res.model };
  });
}

// ---------------------------------------------------------------------------
// Read specific public pages with web fetch (directory listings)
// ---------------------------------------------------------------------------

export interface FetchedDoc {
  url: string;
  title: string | null;
  text: string;
}

export interface FetchRead {
  text: string;
  docs: FetchedDoc[];
  usage: UsageLike;
  costUsd: number;
  /** Set when the turn did not finish (refusal, truncation, pause): text and docs are empty and nothing may be concluded. */
  incomplete?: string;
}

/**
 * Let Claude fetch the given URLs (only those domains) and answer. The fetched
 * documents are returned so every quote can be checked against them. A turn
 * that was refused or cut off returns `incomplete` with no text and no
 * documents (the cost is still returned): callers report "could not verify".
 */
export async function readWithWebFetch(prompt: string, urls: string[]): Promise<FetchRead> {
  const model = env().CLAUDE_MODEL;
  const domains = [...new Set(urls.map((u) => new URL(u).hostname))].slice(0, 20);
  return withRecording("claude-fetch", { model, prompt, urls }, async () => {
    const res = await anthropic().messages.create({
      model,
      max_tokens: 16000,
      output_config: { effort: "low" },
      tools: [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: Math.min(10, urls.length + 2), allowed_domains: domains }],
      messages: [{ role: "user", content: `${prompt}\n\nURLs:\n${urls.join("\n")}` }],
    });
    const usage = res.usage as unknown as UsageLike;
    if (res.stop_reason !== "end_turn" && res.stop_reason !== "stop_sequence") {
      return { text: "", docs: [], usage, costUsd: costUsd(res.model, usage), incomplete: res.stop_reason ?? "none" };
    }
    const docs: FetchedDoc[] = [];
    let text = "";
    for (const b of res.content as unknown as Block[]) {
      if (b.type === "text" && b.text) text += b.text;
      if (b.type === "web_fetch_tool_result") {
        const c = b.content as { type: string; url?: string; content?: { title?: string | null; source?: { type: string; data?: string } } };
        if (c?.type === "web_fetch_result" && c.content?.source?.type === "text") {
          docs.push({ url: c.url ?? "", title: c.content.title ?? null, text: c.content.source.data ?? "" });
        }
      }
    }
    return { text, docs, usage, costUsd: costUsd(res.model, usage) };
  });
}
