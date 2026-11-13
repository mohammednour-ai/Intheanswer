"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { setTypeMode } from "@/lib/sending/modes";
import { checkDns } from "@/lib/sending/dns";

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
  await db()`update app_settings set pages_per_month=${pagesPerMonth}, crawl_page_cap=${crawlCap}, api_cache_days=${cacheDays} where id`;
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
