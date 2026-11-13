import crypto from "node:crypto";
import { db } from "./db";
import { env } from "./env";

/**
 * One random, unguessable code per clinic for the printed QR and the short
 * typed URL (intheanswer.ca/r/CODE). 12 characters from a 31-letter alphabet
 * (about 59 bits), no look-alike characters, never sequential. A code never
 * expires unless the owner revokes it.
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no i, l, o, 0, 1
export const CODE_RE = /^[a-hjkmnp-z2-9]{12}$/;

export function newCode(): string {
  let out = "";
  while (out.length < 12) {
    const b = crypto.randomBytes(1)[0];
    if (b < 248) out += ALPHABET[b % 31]; // 248 = 8 * 31: no modulo bias
  }
  return out;
}

export async function ensureCode(clinicId: string): Promise<string> {
  const sql = db();
  const [have] = await sql<{ code: string }[]>`select code from qr_codes where clinic_id=${clinicId} and revoked_at is null`;
  if (have) return have.code;
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const r = await sql`insert into qr_codes (code, clinic_id) values (${code}, ${clinicId}) on conflict do nothing returning code`;
    if (r.length) return code;
  }
  throw new Error("could not create a code");
}

export async function revokeCode(code: string, actor: string) {
  const sql = db();
  await sql`update qr_codes set revoked_at=now() where code=${code} and revoked_at is null`;
  await sql`insert into settings_audit_log (scope, actor, after) values ('qr', ${actor}, ${sql.json({ revoked: code })})`;
}

/** The clinic a live code belongs to, or null (unknown, malformed or revoked). */
export async function resolveCode(code: string): Promise<{ clinicId: string } | null> {
  if (!CODE_RE.test(code)) return null;
  const [r] = await db()<{ clinic_id: string }[]>`select clinic_id from qr_codes where code=${code} and revoked_at is null`;
  return r ? { clinicId: r.clinic_id } : null;
}

export function shortUrl(code: string, source?: "q" | "e"): string {
  return `${env().APP_URL}/r/${code}${source ? `?s=${source}` : ""}`;
}

/** The URL as printed for typing: no scheme, no tag. */
export function typedUrl(code: string): string {
  return `${new URL(env().APP_URL).host}/r/${code}`;
}

export function visitSource(s: string | null): "qr" | "typed" | "email" {
  return s === "q" ? "qr" : s === "e" ? "email" : "typed";
}

export function deviceType(ua: string): "phone" | "tablet" | "computer" | "unknown" {
  if (!ua) return "unknown";
  if (/ipad|tablet|android(?!.*mobile)/i.test(ua)) return "tablet";
  if (/mobi|iphone|android/i.test(ua)) return "phone";
  return "computer";
}
