import { db } from "./db";
import { isEnvDryRun } from "./env";

export interface AppSettings {
  owner_user_id: string | null;
  owner_email: string | null;
  kill_switch: boolean;
  auto_paused: boolean;
  auto_pause_reason: string | null;
  dry_run: boolean;
  live_enabled: boolean;
  warmup_start_date: string | null;
  warmup_start_per_day: number;
  warmup_step_per_week: number;
  warmup_ceiling: number;
  daily_cap_override: number | null;
  send_window_start: string;
  send_window_end: string;
  timezone: string;
  claude_daily_spend_cap_usd: number;
  pipeline_paused_for_spend: boolean;
  auto_review_first_n: number;
  pending_expiry_days: number;
  bounce_rate_threshold: number;
  follow_up_business_days: number;
  retest_after_purchase_days: number;
  dns_verified: boolean;
  dns_checked_at: Date | null;
  dns_detail: unknown;
  digest_hour_local: number;
  pages_per_month: number;
  crawl_page_cap: number;
  api_cache_days: number;
  discovery_targets_per_day: number;
}

export async function getSettings(): Promise<AppSettings> {
  const sql = db();
  const [s] = await sql<AppSettings[]>`
    select *, to_char(warmup_start_date, 'YYYY-MM-DD') as warmup_start_date,
           to_char(send_window_start, 'HH24:MI') as send_window_start,
           to_char(send_window_end, 'HH24:MI') as send_window_end
    from app_settings where id`;
  return s;
}

/**
 * Effective dry run: true unless BOTH the environment (DRY_RUN=0) and the
 * portal (dry_run off, live_enabled on) allow live operation.
 */
export async function effectiveDryRun(s?: AppSettings): Promise<boolean> {
  if (isEnvDryRun()) return true;
  const st = s ?? (await getSettings());
  return st.dry_run || !st.live_enabled;
}

export type ModeType =
  | "first_email"
  | "follow_up"
  | "interested_reply"
  | "question_answer"
  | "full_report_delivery"
  | "monthly_report";

export const MODE_TYPES: { type: ModeType; label: string }[] = [
  { type: "first_email", label: "First email" },
  { type: "follow_up", label: "Follow-up" },
  { type: "interested_reply", label: "Reply to an interested clinic" },
  { type: "question_answer", label: "Answer to a question" },
  { type: "full_report_delivery", label: "Full report delivery" },
  { type: "monthly_report", label: "Monthly report" },
];

export interface TypeMode {
  type: ModeType;
  mode: "REVIEW" | "AUTO";
  review_first_n: number;
  auto_since: Date | null;
  auto_created_count: number;
}

export async function getModes(): Promise<TypeMode[]> {
  return db()<TypeMode[]>`select * from message_type_modes order by type`;
}
