import { isIP } from "node:net";
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
 * - caps body size
 * - follows redirects itself, one hop at a time, and checks that every hop is
 *   a public http(s) address before requesting it
 */
export const USER_AGENT = "InTheAnswerBot/1.0 (+https://intheanswer.ca/bot)";
export const BOT_TOKEN = "InTheAnswerBot";
const MIN_GAP_MS = 2500;
const CACHE_DAYS = 7;
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/** Hosts that must never be requested: loopback, private, link-local, internal names. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".") && !h.includes(":")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (h.includes(":")) return h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
  return false;
}

export class BlockedUrlError extends Error {}

/**
 * Only public http(s) addresses may be fetched. Names are resolved and every
 * address they resolve to is checked; a name that cannot be resolved is not
 * known to be public, so it is refused too.
 */
export async function assertPublicUrl(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BlockedUrlError("not a valid address");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedUrlError("not an http(s) address");
  if (isPrivateHost(u.hostname)) throw new BlockedUrlError("address is not public");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return; // a literal address, already checked above
  let addrs: { address: string }[];
  try {
    const { lookup } = await import("node:dns/promises");
    addrs = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError("address could not be resolved");
  }
  if (addrs.length === 0) throw new BlockedUrlError("address could not be resolved");
  if (addrs.some((a) => isPrivateHost(a.address))) throw new BlockedUrlError("address resolves to a private network");
}

/**
 * fetch() that follows redirects by hand (at most MAX_REDIRECTS) and runs
 * assertPublicUrl on every hop before requesting it, so a public address
 * cannot bounce the request to a private one. Throws BlockedUrlError when a
 * hop is refused.
 *
 * Limit: the name is resolved once for the check and again by the request
 * itself, so a DNS answer that changes in between (rebinding) is not caught
 * here. Run the worker where private networks are not reachable if that
 * matters.
 */
export async function safeFetch(url: string, init: Omit<RequestInit, "redirect"> = {}): Promise<{ res: Response; finalUrl: string }> {
  let current = url;
  let method = init.method ?? "GET";
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...init, method, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return { res, finalUrl: current };
    await res.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new Error("redirect to an invalid address");
    }
    if (res.status === 303 && method !== "HEAD") method = "GET";
    current = next;
  }
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  /**
   * False when where the request ended is not known: the page came from a
   * cache row stored before the redirect target was kept, or the request never
   * completed. finalUrl is then only the requested URL, and nothing may be
   * concluded from it about redirects or HTTPS.
   */
  finalUrlKnown: boolean;
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
    const { res, finalUrl } = await safeFetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5" },
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
    return { status: res.status, finalUrl, contentType, body };
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
    const [c] = await sql<{ body: string; http_status: number; content_type: string; robots_allowed: boolean; error: string | null; final_url: string | null }[]>`
      select body, http_status, content_type, robots_allowed, error, final_url from page_cache
      where url = ${url} and fetched_at > now() - make_interval(days => ${CACHE_DAYS})`;
    if (c) {
      return {
        url,
        finalUrl: c.final_url ?? url,
        finalUrlKnown: c.final_url != null,
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
    page = { url, finalUrl: url, finalUrlKnown: false, status: 0, contentType: "", body: "", fromCache: false, robotsAllowed: false, error: "disallowed by robots.txt" };
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
      finalUrl: r.finalUrl || url,
      // status 0: the request never completed, so where it would have ended is not known
      finalUrlKnown: r.status > 0 && !!r.finalUrl,
      status: r.status,
      contentType: r.contentType,
      body: r.body,
      fromCache: false,
      robotsAllowed: true,
      error: (r as { error?: string }).error ?? (r.status >= 400 ? `HTTP ${r.status}` : undefined),
    };
  }
  await sql`
    insert into page_cache (url, domain, http_status, content_type, body, body_sha256, robots_allowed, error, final_url)
    values (${url}, ${siteDomain(url)}, ${page.status}, ${page.contentType}, ${page.body},
            ${sha256(page.body)}, ${page.robotsAllowed}, ${page.error ?? null}, ${page.finalUrlKnown ? page.finalUrl : null})
    on conflict (url) do update set fetched_at=now(), http_status=excluded.http_status, content_type=excluded.content_type,
      body=excluded.body, body_sha256=excluded.body_sha256, robots_allowed=excluded.robots_allowed, error=excluded.error,
      final_url=excluded.final_url`;
  return page;
}

export function isEnvLive(): boolean {
  return env().EXTERNAL_MODE !== "replay";
}

/**
 * Status-only probe for link and image checks (HEAD, then a 1-byte GET if HEAD
 * is refused). Returns 0 when the request could not be made (network, DNS,
 * timeout, robots, a redirect to a private address): callers must treat 0 as
 * "could not test", never as broken.
 */
export async function probeUrl(url: string): Promise<{ status: number; reason?: string }> {
  return withRecording("probe", { url }, async () => {
    try {
      await assertPublicUrl(url);
    } catch {
      return { status: 0, reason: "address is not public" };
    }
    try {
      if (!(await robotsAllows(url))) return { status: 0, reason: "disallowed by robots.txt" };
    } catch {
      /* robots unreachable: try the request anyway */
    }
    await politeWait(hostOf(url));
    for (const method of ["HEAD", "GET"] as const) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      try {
        // every redirect hop is checked to be public before it is requested
        const { res } = await safeFetch(url, {
          method,
          signal: ctrl.signal,
          headers: { "user-agent": USER_AGENT, ...(method === "GET" ? { range: "bytes=0-0" } : {}) },
        });
        await res.body?.cancel().catch(() => {});
        if (method === "HEAD" && (res.status === 405 || res.status === 501)) continue;
        return { status: res.status };
      } catch (e) {
        if (e instanceof BlockedUrlError) return { status: 0, reason: "redirects to an address that is not public" };
        if (method === "GET") return { status: 0, reason: (e as Error).message };
      } finally {
        clearTimeout(t);
      }
    }
    return { status: 0, reason: "no response" };
  });
}
