import { z } from "zod";

/**
 * All configuration comes from environment variables (see .env.example).
 * Owner details are required for any live send; dry runs show placeholders.
 */
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
  OWNER_EMAIL: z.string().email().default("hello@intheanswer.ca"),
  // Local development only: lets the portal open without Supabase Auth.
  PORTAL_DEV_BYPASS: z.string().optional(),

  // Owner details used in every email and footer.
  OWNER_NAME: z.string().default("[FULL NAME]"),
  OWNER_BUSINESS_NAME: z.string().default("[REGISTERED BUSINESS NAME]"),
  OWNER_MAILING_ADDRESS: z.string().default("[MAILING ADDRESS]"),
  OWNER_PHONE: z.string().default("[PHONE]"),
  OWNER_CONTACT_EMAIL: z.string().default("hello@intheanswer.ca"),
  MONTHLY_MIN_TERM_MONTHS: z.string().default("[MINIMUM TERM]"),

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

  // Discovery
  GOOGLE_PLACES_API_KEY: z.string().optional(),

  // Payments
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ONE_TIME: z.string().optional(),
  STRIPE_PRICE_MONTHLY: z.string().optional(),

  // Signing secret for unsubscribe links, report tokens, cron calls.
  APP_SECRET: z.string().default("dev-only-secret-change-me"),
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

/** Test helper: reset cached env after mutating process.env. */
export function resetEnvForTests() {
  cached = null;
}

export function isEnvDryRun(): boolean {
  return env().DRY_RUN !== "0";
}

export const OWNER_PLACEHOLDER_RE = /\[[A-Z][A-Z ,.]+\]/;

/** Owner details that must be filled before any live send. */
export function ownerDetails() {
  const e = env();
  return {
    name: e.OWNER_NAME,
    businessName: e.OWNER_BUSINESS_NAME,
    mailingAddress: e.OWNER_MAILING_ADDRESS,
    phone: e.OWNER_PHONE,
    email: e.OWNER_CONTACT_EMAIL,
    minTerm: e.MONTHLY_MIN_TERM_MONTHS,
  };
}

export function ownerDetailsComplete(): { ok: boolean; missing: string[] } {
  const d = ownerDetails();
  const missing = Object.entries(d)
    .filter(([, v]) => OWNER_PLACEHOLDER_RE.test(v))
    .map(([k]) => k);
  return { ok: missing.length === 0, missing };
}
