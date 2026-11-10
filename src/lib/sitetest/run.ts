import { db } from "../db";
import type { JobContext } from "../jobs/queue";
import { PermanentJobError } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { fetchPage, probeUrl, siteDomain } from "../adapters/http";
import { getSettings } from "../settings";
import { crawlSite, type Crawl } from "./crawl";
import {
  checkAccessibility, checkAiBots, checkAltText, checkBookingPath, checkBrokenImages, checkBrokenLinks, checkHeadingOrder,
  checkHttps, checkMixedContent, checkMobileLayout, checkRealText, checkRobotsSitemap, checkSpeed, checkTitlesDescriptions,
  sortByImpact, type Probe, type RenderMetrics, type AxeViolation,
} from "./checks";
import { launchBrowser, measureMobile, runAxe } from "./browser";
import { measureSpeed } from "./perf";
import type { SiteCheck } from "./types";

/**
 * Full site test (part of the audit stage). Every check is stored with its
 * evidence. If anything here fails, the clinic continues without this
 * section; nothing is guessed.
 */

const MAX_EXTERNAL = 25;
const MAX_IMAGES = 40;

export interface SiteTestOutput {
  crawl: Crawl;
  checks: SiteCheck[];
  perfSource: string | null;
  notes: string[];
}

export async function runSiteTest(website: string, opts: { cap: number; cacheDays: number; withBrowser?: boolean; withSpeed?: boolean }): Promise<SiteTestOutput> {
  const notes: string[] = [];
  const crawl = await crawlSite(website, opts.cap);
  const domain = siteDomain(website);

  // sitemap (only if robots.txt does not declare one)
  let sitemap: { url: string; status: number } | null = null;
  if (!/^\s*sitemap:/im.test(crawl.robotsTxt)) {
    const u = new URL("/sitemap.xml", website).toString();
    sitemap = { url: u, status: (await probeUrl(u)).status };
  }
  // http:// -> https:// redirect
  let httpProbe: { finalUrl: string; status: number } | null = null;
  try {
    const f = await fetchPage(`http://${new URL(website).host}/`);
    httpProbe = { finalUrl: f.finalUrl, status: f.status };
  } catch {
    httpProbe = null;
  }

  // external links and images: status only, capped, never counted as broken without a real 404/410
  const externals = new Map<string, string>();
  const images = new Map<string, string>();
  for (const p of crawl.pages) {
    for (const l of p.links) {
      try {
        if (siteDomain(l.href) !== domain && /^https?:/.test(l.href) && !externals.has(l.href)) externals.set(l.href, p.url);
      } catch {
        /* ignore */
      }
    }
    for (const i of p.images) if (/^https?:/.test(i.src) && !images.has(i.src)) images.set(i.src, p.url);
  }
  const extProbes: Probe[] = [];
  for (const [url, foundOn] of [...externals.entries()].slice(0, MAX_EXTERNAL)) extProbes.push({ url, foundOn, ...(await probeUrl(url)) });
  const imgProbes: Probe[] = [];
  for (const [url, foundOn] of [...images.entries()].slice(0, MAX_IMAGES)) imgProbes.push({ url, foundOn, ...(await probeUrl(url)) });

  // browser checks
  let render: RenderMetrics | null = null;
  let axe: { violations: AxeViolation[]; tested: string[] } | null = null;
  if (opts.withBrowser !== false && crawl.home) {
    try {
      const browser = await launchBrowser();
      try {
        try {
          render = await measureMobile(browser, crawl.home.finalUrl);
        } catch (e) {
          notes.push(`mobile render: ${(e as Error).message}`);
        }
        const keyPages = crawl.pages
          .filter((p) => p.depth === 1 && /contact|book|appointment|service|team|about|fee|new-patient/i.test(p.url))
          .slice(0, 4)
          .map((p) => p.url);
        axe = await runAxe(browser, [crawl.home.finalUrl, ...keyPages]);
        if (axe.tested.length === 0) {
          notes.push("accessibility: no page rendered completely");
          axe = null;
        }
      } finally {
        await browser.close();
      }
    } catch (e) {
      notes.push(`browser checks could not run: ${(e as Error).message}`);
    }
  }

  // speed
  let perfSource: string | null = null;
  const speeds = { mobile: null, desktop: null } as Record<"mobile" | "desktop", Awaited<ReturnType<typeof measureSpeed>>["result"]>;
  if (opts.withSpeed !== false && crawl.home) {
    for (const s of ["mobile", "desktop"] as const) {
      const r = await measureSpeed(crawl.home.finalUrl, s, opts.cacheDays);
      speeds[s] = r.result;
      if (r.result) perfSource = r.result.source;
      if (r.error) notes.push(`speed ${s}: ${r.error}`);
    }
  }

  const checks = sortByImpact([
    checkBookingPath(crawl),
    checkMobileLayout(crawl, render),
    checkSpeed(speeds.mobile, "mobile"),
    checkSpeed(speeds.desktop, "desktop"),
    checkHttps(crawl, httpProbe),
    checkBrokenLinks(crawl, extProbes),
    checkRealText(crawl, render),
    checkAccessibility(axe?.violations ?? null, axe?.tested ?? []),
    checkAiBots(crawl),
    checkMixedContent(crawl.pages),
    checkBrokenImages(imgProbes),
    checkAltText(crawl.pages),
    checkTitlesDescriptions(crawl.pages),
    checkHeadingOrder(crawl.pages),
    checkRobotsSitemap(crawl, sitemap),
  ]);
  return { crawl, checks, perfSource, notes };
}

export async function storeSiteTest(clinicId: string, runLabel: string, out: SiteTestOutput, cap: number): Promise<string> {
  const sql = db();
  return sql.begin(async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      insert into site_test_runs (clinic_id, run_label, status, page_cap, pages_crawled, perf_source, error, finished_at)
      values (${clinicId}, ${runLabel}, 'done', ${cap}, ${out.crawl.pages.length}, ${out.perfSource}, ${out.notes.join("; ") || null}, now())
      on conflict (clinic_id, run_label) do update set status='done', pages_crawled=excluded.pages_crawled,
        perf_source=excluded.perf_source, error=excluded.error, finished_at=now()
      returning id`;
    await tx`delete from site_test_checks where run_id=${run.id}`;
    for (const c of out.checks) {
      await tx`insert into site_test_checks (run_id, check_key, category, result, impact, line, finding_text, evidence, metrics)
               values (${run.id}, ${c.key}, ${c.category}, ${c.result}, ${c.impact}, ${c.line},
                       ${c.result === "needs_work" ? (c.findingText ?? null) : null},
                       ${tx.json(c.evidence as never)}, ${tx.json((c.metrics ?? {}) as never)})`;
    }
    return run.id;
  });
}

async function handleSiteTest(ctx: JobContext) {
  const { clinicId, runLabel } = ctx.job.payload as { clinicId: string; runLabel: string };
  const sql = db();
  const [c] = await sql<{ website: string | null }[]>`select website from clinics where id=${clinicId}`;
  if (!c?.website) throw new PermanentJobError("clinic has no website");
  const s = await getSettings();
  try {
    const started = Date.now();
    const out = await runSiteTest(c.website, { cap: s.crawl_page_cap, cacheDays: s.api_cache_days });
    const runId = await storeSiteTest(clinicId, runLabel, out, s.crawl_page_cap);
    await ctx.cost({
      provider: out.perfSource ?? "site_test",
      operation: "site_test",
      units: { pages: out.crawl.pages.length, seconds: Math.round((Date.now() - started) / 1000) },
      costUsd: 0, // PageSpeed Insights and local checks have no per-call charge
      clinicId,
    });
    return { runId, pages: out.crawl.pages.length, needsWork: out.checks.filter((x) => x.result === "needs_work").map((x) => x.key), notes: out.notes };
  } catch (e) {
    if (ctx.job.attempts >= ctx.job.max_attempts) {
      await sql`insert into site_test_runs (clinic_id, run_label, status, page_cap, error, finished_at)
                values (${clinicId}, ${runLabel}, 'failed', ${s.crawl_page_cap}, ${(e as Error).message}, now())
                on conflict (clinic_id, run_label) do update set status='failed', error=excluded.error, finished_at=now()`;
    }
    throw e;
  }
}

register("site_test", handleSiteTest);
