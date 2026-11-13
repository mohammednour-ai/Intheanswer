import { z } from "zod";

/**
 * All configuration comes from environment variables (see .env.example).
 * Owner details are required for any live send; dry runs show placeholders.
 */
/** Placeholder secret for local development. Never accepted in production (see appSecret). */
export const DEV_APP_SECRET = "dev-only-secret-change-me";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  // Database: direct Postgres connection used by server code and jobs.
  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5432/intheanswer"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default("reports"),

  // The single account allowed into the portal.
  OWNER_EMAIL: z.string().trim().toLowerCase().email().default("hello@intheanswer.ca"),
  // Local development only: lets the portal open without Supabase Auth.
  PORTAL_DEV_BYPASS: z.string().optional(),

  // Owner details used in every email and footer.
  OWNER_NAME: z.string().default("[FULL NAME]"),
  OWNER_BUSINESS_NAME: z.string().default("[REGISTERED BUSINESS NAME]"),
  OWNER_MAILING_ADDRESS: z.string().default("[MAILING ADDRESS]"),
  OWNER_PHONE: z.string().default("[PHONE]"),
  OWNER_CONTACT_EMAIL: z.string().default("hello@intheanswer.ca"),
  MONTHLY_MIN_TERM_MONTHS: z.string().default("[MINIMUM TERM]"), // full service plan
  REPORTS_MIN_TERM_MONTHS: z.string().default("3"),              // monthly reports plan

  // Sending
  MAIL_FROM: z.string().default("hello@mail.intheanswer.ca"),
  MAIL_FROM_NAME: z.string().optional(),
  MAIL_REPLY_TO: z.string().default("hello@intheanswer.ca"),
  SENDING_DOMAIN: z.string().default("mail.intheanswer.ca"),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  RESEND_DOMAIN_ID: z.string().optional(),

  // Analysis
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),

  // Discovery and live review numbers (Places API: only place_id is ever stored)
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  // Site test speed. Without a key, a local Lighthouse lab run is used instead.
  PAGESPEED_API_KEY: z.string().optional(),
  // Google Business Profile (monthly clients connect their own profile)
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),

  // Payments
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ONE_TIME: z.string().optional(),
  STRIPE_PRICE_MONTHLY: z.string().optional(),
  STRIPE_PRICE_REPORTS_MONTHLY: z.string().optional(), // 50 CAD / month
  STRIPE_PRICE_REPORTS_FIRST: z.string().optional(),   // 100 CAD one time, added to the first month (150 in total)
  STRIPE_TAX_RATE_ID: z.string().optional(), // HST tax rate (txr_...), added to every checkout when set

  // Signing secret for unsubscribe links, report tokens, cron calls.
  APP_SECRET: z.string().default(DEV_APP_SECRET),
  CRON_SECRET: z.string().optional(),

  // Chrome for PDF rendering (local). On Vercel @sparticuz/chromium is used.
  CHROME_PATH: z.string().optional(),

  // Global dry-run override from the environment. When "1", nothing is sent or
  // charged regardless of portal settings.
  DRY_RUN: z.string().default("1"),
  // Record/replay of external reads, for tests and repeatable demos.
  EXTERNAL_MODE: z.enum(["live", "record", "replay"]).default("live"),
  FIXTURES_DIR: z.string().default("fixtures/recorded"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;
export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

/**
 * The signing secret, for use at request time (unsubscribe links, sealed
 * tokens, hashed IPs). In production the development default or anything
 * under 32 characters is refused: links signed with a known secret could be
 * forged. Checked here and not at module load because `next build` also runs
 * with NODE_ENV=production and must succeed without secrets.
 */
export function appSecret(): string {
  const e = env();
  const building = process.env.NEXT_PHASE === "phase-production-build";
  if (e.NODE_ENV === "production" && !building && (e.APP_SECRET === DEV_APP_SECRET || e.APP_SECRET.length < 32)) {
    throw new Error("APP_SECRET must be set to a random value of at least 32 characters in production");
  }
  return e.APP_SECRET;
}

/** Test helper: reset cached env after mutating process.env. */
export function resetEnvForTests() {
  cached = null;
}

export function isEnvDryRun(): boolean {
  return env().DRY_RUN !== "0";
}

export const OWNER_PLACEHOLDER_RE = /\[[A-Z][A-Z ,.]+\]/;

/** "12" reads as "12 months"; anything else (a placeholder, "12 months") is shown as written. */
function termLabel(raw: string): string {
  const t = raw.trim();
  return /^\d{1,2}$/.test(t) ? (t === "1" ? "1 month" : `${t} months`) : t;
}

/** Owner details that must be filled before any live send. */
export function ownerDetails() {
  const e = env();
  return {
    name: e.OWNER_NAME,
    businessName: e.OWNER_BUSINESS_NAME,
    mailingAddress: e.OWNER_MAILING_ADDRESS,
    phone: e.OWNER_PHONE,
    email: e.OWNER_CONTACT_EMAIL,
    minTerm: termLabel(e.MONTHLY_MIN_TERM_MONTHS),
    reportsMinTerm: termLabel(e.REPORTS_MIN_TERM_MONTHS),
    /** The full service term as an adjective: "12-month" (a placeholder is shown as written). */
    contractTerm: termLabel(e.MONTHLY_MIN_TERM_MONTHS).replace(/^(\d+) months?$/, "$1-month"),
  };
}

export function ownerDetailsComplete(): { ok: boolean; missing: string[] } {
  const d = ownerDetails();
  const missing = Object.entries(d)
    .filter(([, v]) => OWNER_PLACEHOLDER_RE.test(v))
    .map(([k]) => k);
  return { ok: missing.length === 0, missing };
}
