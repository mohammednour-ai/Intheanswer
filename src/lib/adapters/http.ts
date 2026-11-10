import robotsParser from "robots-parser";
import { db } from "../db";
import { env } from "../env";
import { sha256 } from "../tokens";
import { withRecording } from "./recorder";

/**
 * Polite fetcher for clinic websites.
 * - identifies itself, honours robots.txt for our user agent
 * - one request per domain every MIN_GAP_MS
 * - caches pages in page_cache (reused for CACHE_DAYS)
 * - caps body size, follows redirects only within http(s)
 */
export const USER_AGENT = "InTheAnswerBot/1.0 (+https://intheanswer.ca/bot)";
export const BOT_TOKEN = "InTheAnswerBot";
const MIN_GAP_MS = 2500;
const CACHE_DAYS = 7;
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 20_000;

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  fromCache: boolean;
  robotsAllowed: boolean;
  error?: string;
}

const lastHit = new Map<string, number>();
const robotsCache = new Map<string, { txt: string; status: number }>();

export function hostOf(u: string): string {
  return new URL(u).hostname.toLowerCase();
}

/** Registrable-ish domain: strips a leading www. Good enough for clinic sites (.ca/.com). */
export function siteDomain(u: string): string {
  return hostOf(u).replace(/^www\./, "");
}

async function politeWait(host: string) {
  const last = lastHit.get(host) ?? 0;
  const wait = last + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

async function rawGet(url: string): Promise<{ status: number; finalUrl: string; contentType: string; body: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    const contentType = res.headers.get("content-type") ?? "";
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return { status: res.status, finalUrl: res.url || url, contentType, body };
  } finally {
    clearTimeout(t);
  }
}

/** Fetch and parse robots.txt for a host (cached per process). */
export async function getRobots(origin: string): Promise<{ txt: string; status: number }> {
  const host = hostOf(origin);
  const hit = robotsCache.get(host);
  if (hit) return hit;
  const robotsUrl = new URL("/robots.txt", origin).toString();
  const r = await withRecording("http", { url: robotsUrl }, async () => {
    await politeWait(host);
    try {
      const g = await rawGet(robotsUrl);
      return { txt: g.status === 200 ? g.body : "", status: g.status };
    } catch {
      return { txt: "", status: 0 };
    }
  });
  robotsCache.set(host, r);
  return r;
}

export async function robotsAllows(url: string, agent = BOT_TOKEN): Promise<boolean> {
  const origin = new URL(url).origin;
  const { txt } = await getRobots(origin);
  if (!txt) return true; // no robots.txt: allowed
  const robots = robotsParser(new URL("/robots.txt", origin).toString(), txt);
  return robots.isAllowed(url, agent) !== false;
}

export async function fetchPage(url: string, opts: { useCache?: boolean } = {}): Promise<FetchedPage> {
  const sql = db();
  const useCache = opts.useCache ?? true;
  if (useCache) {
    const [c] = await sql<{ body: string; http_status: number; content_type: string; robots_allowed: boolean; error: string | null }[]>`
      select body, http_status, content_type, robots_allowed, error from page_cache
      where url = ${url} and fetched_at > now() - make_interval(days => ${CACHE_DAYS})`;
    if (c) {
      return {
        url,
        finalUrl: url,
        status: c.http_status,
        contentType: c.content_type,
        body: c.body ?? "",
        fromCache: true,
        robotsAllowed: c.robots_allowed,
        error: c.error ?? undefined,
      };
    }
  }

  const allowed = await robotsAllows(url);
  let page: FetchedPage;
  if (!allowed) {
    page = { url, finalUrl: url, status: 0, contentType: "", body: "", fromCache: false, robotsAllowed: false, error: "disallowed by robots.txt" };
  } else {
    const r = await withRecording("http", { url }, async () => {
      await politeWait(hostOf(url));
      try {
        return await rawGet(url);
      } catch (e) {
        return { status: 0, finalUrl: url, contentType: "", body: "", error: (e as Error).message };
      }
    });
    page = {
      url,
      finalUrl: r.finalUrl,
      status: r.status,
      contentType: r.contentType,
      body: r.body,
      fromCache: false,
      robotsAllowed: true,
      error: (r as { error?: string }).error ?? (r.status >= 400 ? `HTTP ${r.status}` : undefined),
    };
  }
  await sql`
    insert into page_cache (url, domain, http_status, content_type, body, body_sha256, robots_allowed, error)
    values (${url}, ${siteDomain(url)}, ${page.status}, ${page.contentType}, ${page.body},
            ${sha256(page.body)}, ${page.robotsAllowed}, ${page.error ?? null})
    on conflict (url) do update set fetched_at=now(), http_status=excluded.http_status, content_type=excluded.content_type,
      body=excluded.body, body_sha256=excluded.body_sha256, robots_allowed=excluded.robots_allowed, error=excluded.error`;
  return page;
}

export function isEnvLive(): boolean {
  return env().EXTERNAL_MODE !== "replay";
}
