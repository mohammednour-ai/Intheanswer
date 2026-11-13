import crypto from "node:crypto";
import { appSecret, env } from "./env";

/** Unguessable URL token (report links, intake forms). 128 bits, base64url. */
export function randomToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(s: string | Buffer): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function hmac(data: string): string {
  return crypto.createHmac("sha256", appSecret()).update(data).digest("base64url").slice(0, 32);
}

/**
 * Unsubscribe token: works without login, never expires, encodes the address.
 * Format: base64url(email).signature
 */
export function unsubscribeToken(email: string): string {
  const e = email.trim().toLowerCase();
  return `${Buffer.from(e).toString("base64url")}.${hmac("unsub:" + e)}`;
}

export function verifyUnsubscribeToken(token: string): string | null {
  const [b, sig] = token.split(".");
  if (!b || !sig) return null;
  let email: string;
  try {
    email = Buffer.from(b, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = hmac("unsub:" + email);
  const a = Buffer.from(sig);
  const c = Buffer.from(expected);
  if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null;
  return email;
}

export function unsubscribeUrl(email: string): string {
  return `${env().APP_URL}/unsubscribe/${unsubscribeToken(email)}`;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
