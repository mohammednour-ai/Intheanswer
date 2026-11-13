import { db } from "../db";
import { env } from "../env";
import { withRecording } from "../adapters/recorder";
import { executablePath } from "../reports/pdf";
import { proxyArgs } from "./browser";
import { assertPublicUrl } from "../adapters/http";
import type { PerfResult } from "./checks";

/**
 * Speed: PageSpeed Insights API when PAGESPEED_API_KEY is set (lab + real-visitor
 * field data), otherwise a local Lighthouse lab run (no field data). Results are
 * cached in api_cache for api_cache_days (default 7).
 */

async function cached<T>(key: string, provider: string, days: number, fn: () => Promise<T | null>): Promise<{ value: T | null; fromCache: boolean }> {
  const sql = db();
  const [hit] = await sql<{ value: T }[]>`select value from api_cache where key=${key} and expires_at > now()`;
  if (hit) return { value: hit.value, fromCache: true };
  const value = await fn();
  if (value) {
    await sql`insert into api_cache (key, provider, value, expires_at)
              values (${key}, ${provider}, ${sql.json(value as never)}, now() + make_interval(days => ${days}))
              on conflict (key) do update set value=excluded.value, fetched_at=now(), expires_at=excluded.expires_at`;
  }
  return { value, fromCache: false };
}

type Audits = Record<string, { numericValue?: number }>;
function labFrom(audits: Audits) {
  const n = (k: string) => (audits[k]?.numericValue == null ? null : Math.round(audits[k].numericValue! * (k === "cumulative-layout-shift" ? 1000 : 1)) / (k === "cumulative-layout-shift" ? 1000 : 1));
  return { lcpMs: n("largest-contentful-paint"), cls: n("cumulative-layout-shift"), tbtMs: n("total-blocking-time"), fcpMs: n("first-contentful-paint") };
}

async function pagespeed(url: string, strategy: "mobile" | "desktop", key: string): Promise<PerfResult | null> {
  const u = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  u.searchParams.set("url", url);
  u.searchParams.set("strategy", strategy);
  u.searchParams.set("category", "performance");
  const res = await fetch(u, { headers: { "X-Goog-Api-Key": key } });
  if (!res.ok) throw new Error(`PageSpeed ${res.status}`);
  const j = (await res.json()) as {
    lighthouseResult?: { categories?: { performance?: { score?: number } }; audits?: Audits };
    loadingExperience?: { overall_category?: string; metrics?: Record<string, { percentile?: number }> };
  };
  const m = j.loadingExperience?.metrics;
  return {
    source: "pagespeed",
    strategy,
    url,
    score: j.lighthouseResult?.categories?.performance?.score ?? null,
    lab: labFrom(j.lighthouseResult?.audits ?? {}),
    field: m
      ? {
          category: j.loadingExperience?.overall_category ?? null,
          lcpMs: m.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
          inpMs: m.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
          cls: m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null ? m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null,
        }
      : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function lighthouseLocal(url: string, strategy: "mobile" | "desktop"): Promise<PerfResult | null> {
  // Checked again right before the run: the address must be public now, not
  // only when the crawl started.
  // Limit: Lighthouse drives its own Chromium and we do not intercept its
  // requests, so a redirect or a sub-resource on the page can still reach a
  // private address from this machine. Only the start URL is guaranteed
  // public. Set PAGESPEED_API_KEY (the test then runs at Google, not here) or
  // run this worker on a host with no route to private networks.
  await assertPublicUrl(url);
  const { default: lighthouse } = await import("lighthouse");
  const chromeLauncher = await import("chrome-launcher");
  const exe = await executablePath();
  const chrome = await chromeLauncher.launch({ chromePath: exe.path, chromeFlags: ["--headless=new", "--no-sandbox", ...proxyArgs()] });
  try {
    const flags = strategy === "desktop"
      ? { formFactor: "desktop" as const, screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false }, throttlingMethod: "simulate" as const }
      : { formFactor: "mobile" as const };
    const r = await lighthouse(url, { port: chrome.port, output: "json", logLevel: "error", onlyCategories: ["performance"], ...flags });
    if (!r || r.lhr.runtimeError) return null;
    // A stylesheet or own-site script that failed at the network level makes the lab numbers meaningless.
    const host = new URL(url).hostname.replace(/^www\./, "");
    const items = ((r.lhr.audits["network-requests"]?.details as { items?: { url: string; statusCode: number; resourceType?: string }[] } | undefined)?.items ?? []);
    const broken = items.filter((i) => {
      let h = "";
      try { h = new URL(i.url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
      const own = h === host || h.endsWith("." + host);
      return i.statusCode <= 0 && (i.resourceType === "Stylesheet" || (own && (i.resourceType === "Script" || i.resourceType === "Document")));
    });
    if (broken.length) throw new Error(`page files did not load during the lab test (${broken[0].url})`);
    return {
      source: "lighthouse_local",
      strategy,
      url,
      score: r.lhr.categories.performance?.score ?? null,
      lab: labFrom(r.lhr.audits as Audits),
      field: null,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    await chrome.kill();
  }
}

export async function measureSpeed(url: string, strategy: "mobile" | "desktop", cacheDays: number): Promise<{ result: PerfResult | null; fromCache: boolean; error?: string }> {
  const key = env().PAGESPEED_API_KEY;
  const source = key ? "pagespeed" : "lighthouse_local";
  try {
    const r = await cached(`perf:${source}:${strategy}:${url}`, source, cacheDays, () =>
      withRecording("perf", { source, url, strategy }, () => (key ? pagespeed(url, strategy, key) : lighthouseLocal(url, strategy))),
    );
    return { result: r.value, fromCache: r.fromCache };
  } catch (e) {
    return { result: null, fromCache: false, error: (e as Error).message };
  }
}
