import { db } from "../db";
import { queueOwnerMail } from "../sending/outbox";

/**
 * Intake form of the full service plan: a no-login page behind an unguessable token.
 * One submission per token; tries are limited per token.
 */

export const INTAKE_FIELDS = [
  { key: "contact_name", label: "Your name and role at the clinic", required: true, long: false, max: 200 },
  { key: "site_contact", label: "Who looks after your website? Name, and an email or phone number", required: true, long: false, max: 300 },
  { key: "site_platform", label: "What is the website built with, if you know? (for example WordPress, Wix, Squarespace)", required: false, long: false, max: 200 },
  { key: "changes", label: "What would you like changed first?", required: false, long: true, max: 3000 },
  { key: "approver", label: "Who approves new pages before they go live? Name and email", required: true, long: false, max: 300 },
  { key: "booking_link", label: "The booking link you want patients to use", required: false, long: false, max: 500 },
  { key: "notes", label: "Anything else we should know (regulator rules you follow, pages not to touch, busy times)", required: false, long: true, max: 3000 },
] as const;

export type IntakeKey = (typeof INTAKE_FIELDS)[number]["key"];
export type IntakeAnswers = Partial<Record<IntakeKey, string>>;

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_TRIES_PER_HOUR = 5;
/** "password: hunter2", "pwd = ...", "login/pass ..." */
const PASSWORD_RE = /\b(pass(word|code)?|pwd|mot de passe)\b\s*(is|[:=])/i;

export interface IntakeForm {
  id: string;
  clinicId: string;
  clinicName: string;
  submitted: boolean;
}

function isEmpty(a: unknown): boolean {
  return !a || typeof a !== "object" || Object.values(a as Record<string, unknown>).every((v) => !String(v ?? "").trim());
}

export async function loadIntake(token: string): Promise<IntakeForm | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [f] = await db()<{ id: string; clinic_id: string; name: string; submitted_at: Date | null; answers: unknown }[]>`
    select f.id, f.clinic_id, coalesce(c.site_name, c.name) as name, f.submitted_at, f.answers
    from intake_forms f join clinics c on c.id = f.clinic_id where f.token = ${token}`;
  if (!f) return null;
  return { id: f.id, clinicId: f.clinic_id, clinicName: f.name, submitted: !!f.submitted_at && !isEmpty(f.answers) };
}

export type IntakeResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "already" | "rate_limited" | "invalid"; message: string };

export async function submitIntake(token: string, raw: Record<string, unknown>): Promise<IntakeResult> {
  if (!TOKEN_RE.test(token)) return { ok: false, error: "not_found", message: "This link is not valid." };
  const sql = db();
  // count the try first, in one statement, so parallel posts cannot slip past the limit
  const [f] = await sql<{ id: string; clinic_id: string; order_id: string | null; submitted_at: Date | null; answers: unknown; attempt_count: number }[]>`
    update intake_forms set
      attempt_count = case when attempt_window_start is null or attempt_window_start < now() - interval '1 hour' then 1 else attempt_count + 1 end,
      attempt_window_start = case when attempt_window_start is null or attempt_window_start < now() - interval '1 hour' then now() else attempt_window_start end
    where token = ${token}
    returning id, clinic_id, order_id, submitted_at, answers, attempt_count`;
  if (!f) return { ok: false, error: "not_found", message: "This link is not valid." };
  if (f.submitted_at && !isEmpty(f.answers)) return { ok: false, error: "already", message: "This form has already been sent. To change an answer, reply to our email." };
  if (f.attempt_count > MAX_TRIES_PER_HOUR) return { ok: false, error: "rate_limited", message: "Too many tries. Please wait an hour and try again." };

  const answers: IntakeAnswers = {};
  for (const field of INTAKE_FIELDS) {
    const v = typeof raw[field.key] === "string" ? (raw[field.key] as string).replace(/\r\n/g, "\n").trim().slice(0, field.max) : "";
    if (v) answers[field.key] = v;
  }
  if (isEmpty(answers)) return { ok: false, error: "invalid", message: "The form is empty. Please fill in the marked fields." };
  const missing = INTAKE_FIELDS.filter((x) => x.required && !answers[x.key]);
  if (missing.length) return { ok: false, error: "invalid", message: `Please fill in: ${missing.map((m) => m.label.split("?")[0].split(".")[0]).join("; ")}.` };
  if (Object.values(answers).some((v) => PASSWORD_RE.test(v))) {
    return { ok: false, error: "invalid", message: "It looks like a password is in the form. Please remove it. Never send passwords by this form; we will arrange access another way." };
  }
  if (answers.booking_link && !/^https?:\/\/\S+$/i.test(answers.booking_link)) {
    return { ok: false, error: "invalid", message: "The booking link must be a web address starting with https://." };
  }

  const saved = await sql`
    update intake_forms set answers = ${sql.json(answers as never)}, submitted_at = now()
    where id = ${f.id} and (submitted_at is null or answers is null or answers = '{}'::jsonb) returning id`;
  if (!saved.length) return { ok: false, error: "already", message: "This form has already been sent." };

  const [c] = await sql<{ name: string }[]>`select coalesce(site_name, name) as name from clinics where id = ${f.clinic_id}`;
  const title = `Onboard ${c.name}: intake received`;
  const body = INTAKE_FIELDS.filter((x) => answers[x.key]).map((x) => `${x.label}\n${answers[x.key]}`).join("\n\n");
  const updated = f.order_id
    ? await sql`update owner_tasks set title = ${title}, body = ${body} where kind = 'onboarding' and order_id = ${f.order_id} and status = 'open' returning id`
    : [];
  if (!updated.length) {
    const open = await sql`
      update owner_tasks set title = ${title}, body = ${body}
      where id = (select id from owner_tasks where kind = 'onboarding' and clinic_id = ${f.clinic_id} and status = 'open' order by created_at desc limit 1)
      returning id`;
    if (!open.length) {
      // the first task was already closed: open a new one (not tied to the order, which allows one task only)
      await sql`insert into owner_tasks (kind, clinic_id, title, body) values ('onboarding', ${f.clinic_id}, ${title}, ${body})`;
    }
  }
  await queueOwnerMail("owner_alert", `intake:${f.id}`, `Intake form received: ${c.name}`, `${c.name} sent the intake form.\n\n${body}`);
  return { ok: true };
}
