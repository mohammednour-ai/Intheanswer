"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { setTypeMode } from "@/lib/sending/modes";
import { checkDns } from "@/lib/sending/dns";
import { ontarioMunicipality, cityKey } from "@/lib/site/ontarioCities";
import { redirect } from "next/navigation";
import { isPillarKey, isPromiseKey } from "@/lib/offer";

function num(v: FormDataEntryValue | null, min: number, max: number): number | null {
  if (v === null || String(v).trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`value out of range ${min}-${max}`);
  return n;
}

function time(v: FormDataEntryValue | null): string {
  const s = String(v ?? "");
  if (!/^\d{2}:\d{2}$/.test(s)) throw new Error("time must be HH:MM");
  return s;
}

export async function setModeAction(type: string, form: FormData) {
  await requireOwner();
  const mode = String(form.get("mode")) === "AUTO" ? "AUTO" : "REVIEW";
  const firstN = num(form.get("review_first_n"), 0, 1000) ?? 10;
  await setTypeMode(type, mode, firstN);
  revalidatePath("/portal/settings");
}

export async function setKillSwitchAction(on: boolean) {
  await requireOwner();
  await db()`update app_settings set kill_switch = ${on}, updated_at = now() where id`;
  revalidatePath("/portal", "layout");
}

export async function clearAutoPauseAction() {
  await requireOwner();
  await db()`update app_settings set auto_paused=false, auto_pause_reason=null, auto_paused_at=null, auto_pause_cleared_at=now(), updated_at=now() where id`;
  revalidatePath("/portal", "layout");
}

export async function saveSendingAction(form: FormData) {
  await requireOwner();
  const cap = num(form.get("daily_cap_override"), 0, 40);
  const start = time(form.get("send_window_start"));
  const end = time(form.get("send_window_end"));
  if (start >= end) throw new Error("window start must be before end");
  const spend = num(form.get("claude_daily_spend_cap_usd"), 0, 10000) ?? 25;
  const firstN = num(form.get("auto_review_first_n"), 0, 1000) ?? 10;
  const warm = String(form.get("warmup_start_date") ?? "").trim() || null;
  if (warm && !/^\d{4}-\d{2}-\d{2}$/.test(warm)) throw new Error("warm-up date must be YYYY-MM-DD");
  const pagesPerMonth = num(form.get("pages_per_month"), 0, 20) ?? 2;
  const crawlCap = num(form.get("crawl_page_cap"), 5, 200) ?? 40;
  const cacheDays = num(form.get("api_cache_days"), 1, 30) ?? 7;
  const perDay = num(form.get("discovery_targets_per_day"), 0, 30) ?? 2;
  await db()`update app_settings set pages_per_month=${pagesPerMonth}, crawl_page_cap=${crawlCap}, api_cache_days=${cacheDays},
             discovery_targets_per_day=${perDay} where id`;
  await db()`update app_settings set daily_cap_override=${cap}, send_window_start=${start}, send_window_end=${end},
             claude_daily_spend_cap_usd=${spend}, auto_review_first_n=${firstN}, warmup_start_date=${warm},
             updated_at=now() where id`;
  revalidatePath("/portal/settings");
}

export async function setLiveAction(live: boolean) {
  await requireOwner();
  await db()`update app_settings set live_enabled=${live}, dry_run=${!live}, updated_at=now() where id`;
  revalidatePath("/portal", "layout");
}

export async function saveCityAction(form: FormData) {
  await requireOwner();
  const name = String(form.get("name") ?? "").trim();
  if (!name) throw new Error("city name required");
  const lat = num(form.get("lat"), -90, 90);
  const lng = num(form.get("lng"), -180, 180);
  const radius = num(form.get("radius_m"), 1000, 50000) ?? 15000;
  const sql = db();
  const [c] = await sql<{ id: number }[]>`
    insert into cities (name, lat, lng, radius_m) values (${name}, ${lat}, ${lng}, ${radius})
    on conflict (name, province) do update set lat=excluded.lat, lng=excluded.lng, radius_m=excluded.radius_m, active=true
    returning id`;
  await sql`insert into discovery_targets (sector_id, city_id) select id, ${c.id} from sectors on conflict do nothing`;
  revalidatePath("/portal/settings");
}

/**
 * Switch a city on or off for discovery. On: the city row is created if needed and
 * gets a discovery target for every sector, so it joins the monthly search.
 * Off: no new discovery there; clinics already found and paid work carry on.
 */
export async function setCityActiveAction(name: string, active: boolean) {
  await requireOwner();
  const sql = db();
  const [existing] = await sql<{ id: number }[]>`select id from cities where lower(name)=lower(${name}) and province='ON' limit 1`;
  if (!existing && !ontarioMunicipality(name)) throw new Error("unknown city");
  await switchCity(existing?.id ?? null, ontarioMunicipality(name) ?? name, active);
  revalidatePath("/portal/settings");
}

async function switchCity(existingId: number | null, name: string, active: boolean) {
  const sql = db();
  const [c] = existingId
    ? await sql<{ id: number }[]>`update cities set active=${active} where id=${existingId} returning id`
    : await sql<{ id: number }[]>`insert into cities (name, active) values (${name}, ${active})
        on conflict (name, province) do update set active=excluded.active returning id`;
  if (active) {
    await sql`insert into discovery_targets (sector_id, city_id) select id, ${c.id} from sectors on conflict do nothing`;
    await sql`update discovery_targets set active=true where city_id=${c.id}`;
  }
}

/** A place name as typed: letters (accents too), spaces, dots, hyphens and apostrophes. */
const PLACE_RE = /^[\p{L}][\p{L} .'’-]{1,59}$/u;

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
}

/**
 * Turn on one or more cities typed into the box, separated by commas or new lines.
 * Listed municipalities take their listed spelling; other Ontario place names
 * (a neighbourhood such as North York) are accepted as typed.
 */
export async function addCitiesAction(form: FormData) {
  await requireOwner();
  const names = String(form.get("cities") ?? "").split(/[,;\n]+/).map((n) => n.trim().replace(/\s+/g, " ")).filter(Boolean);
  const sql = db();
  const rows = await sql<{ id: number; name: string; active: boolean }[]>`select id, name, active from cities where province='ON'`;
  const byKey = new Map(rows.map((r) => [cityKey(r.name), r]));
  const added: string[] = [], already: string[] = [], bad: string[] = [];
  const seen = new Set<string>();
  for (const raw of names.slice(0, 50)) {
    const key = cityKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const existing = byKey.get(key);
    if (existing?.active) { already.push(existing.name); continue; }
    const listed = ontarioMunicipality(raw);
    if (!existing && !listed && !PLACE_RE.test(raw)) { bad.push(raw); continue; }
    const name = existing?.name ?? listed ?? titleCase(raw);
    await switchCity(existing?.id ?? null, name, true);
    added.push(listed || existing ? name : `${name} (not on the municipality list)`);
  }
  const parts = [
    added.length && `Turned on: ${added.join(", ")}.`,
    already.length && `Already on: ${already.join(", ")}.`,
    bad.length && `Not a place name: ${bad.join(", ")}.`,
  ].filter(Boolean);
  revalidatePath("/portal/settings");
  redirect(`/portal/settings?cities=${encodeURIComponent(parts.join(" ") || "Type at least one city.")}#cities-h`);
}

export async function toggleTargetAction(id: number, active: boolean) {
  await requireOwner();
  await db()`update discovery_targets set active=${active} where id=${id}`;
  revalidatePath("/portal/settings");
}

export async function saveQuestionsAction(sectorId: number, form: FormData) {
  await requireOwner();
  const lines = String(form.get("questions") ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 5 || lines.length > 6) throw new Error("use five or six questions");
  if (!lines.every((l) => l.includes("{city}"))) throw new Error("every question must contain {city}");
  const sql = db();
  // a new version keeps old test runs comparable; monthly retests reuse the version they started with
  const [v] = await sql<{ v: number }[]>`select coalesce(max(version),0)+1 as v from question_sets where sector_id=${sectorId}`;
  await sql`update question_sets set active=false where sector_id=${sectorId}`;
  await sql`insert into question_sets (sector_id, version, questions) values (${sectorId}, ${v.v}, ${sql.json(lines)})`;
  revalidatePath("/portal/settings");
}

export async function saveSectorAction(form: FormData) {
  await requireOwner();
  const slug = String(form.get("slug") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{2,30}$/.test(slug)) throw new Error("slug: lowercase letters, digits, dashes");
  const name = String(form.get("name") ?? "").trim();
  const noun = String(form.get("patient_noun") ?? "").trim();
  const query = String(form.get("places_query") ?? "").trim();
  const reg = String(form.get("regulator_note") ?? "").trim();
  if (!name || !noun || !query.includes("{city}") || !reg) throw new Error("all sector fields are required; query needs {city}");
  const sql = db();
  const [s] = await sql<{ id: number }[]>`
    insert into sectors (slug, name, patient_noun, places_query, regulator_note)
    values (${slug}, ${name}, ${noun}, ${query}, ${reg})
    on conflict (slug) do update set name=excluded.name, patient_noun=excluded.patient_noun,
      places_query=excluded.places_query, regulator_note=excluded.regulator_note
    returning id`;
  await sql`insert into discovery_targets (sector_id, city_id) select ${s.id}, id from cities on conflict do nothing`;
  revalidatePath("/portal/settings");
}

export async function checkDnsAction() {
  await requireOwner();
  await checkDns();
  revalidatePath("/portal/settings");
}

/**
 * Which promises and pillars are stated right now. Only keys the offer defines are stored; what is
 * unticked is no longer said on the site, in a report, in an email or on a call from the next request on.
 */
export async function saveOfferSwitchesAction(form: FormData) {
  await requireOwner();
  const promises = [...new Set(form.getAll("promise").map(String).filter(isPromiseKey))];
  const pillars = [...new Set(form.getAll("pillar").map(String).filter(isPillarKey))];
  await db()`update app_settings set offer_promises = ${promises}, offer_pillars = ${pillars}, updated_at = now() where id`;
  revalidatePath("/", "layout");
  redirect("/portal/settings#offer-h");
}
