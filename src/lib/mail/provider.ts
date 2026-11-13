import crypto from "node:crypto";
import { env } from "../env";

/**
 * Print-and-mail provider. PostGrid Print & Mail API (docs read 2026-11-13):
 *   base    https://api.postgrid.com/print-mail/v1     auth header  x-api-key
 *   POST /contacts   creates and (with a live key) verifies an address:
 *                    addressStatus = verified | corrected | failed (SERP certified for Canada)
 *   POST /letters    multipart: to, from, pdf, color, doubleSided, addressPlacement, mailingClass, description, metadata
 *   POST /postcards  multipart: to, from, pdf, size (6x4 | 9x6 | 11x6)
 *   DELETE /letters/:id   cancel
 *   Idempotency-Key header on order creation (24 hours)
 *   Order status: ready -> printing -> processed_for_delivery -> completed | cancelled
 *   Webhooks: letter.created/updated, postcard.created/updated; payload is a JWT signed HS256 with the webhook secret
 * A test key (test_sk_...) never mails anything and does not verify addresses.
 * Returned-to-sender tracking exists only for US mail (imbStatus); for Canada a
 * returned piece comes back to the return address and is marked by hand.
 */
export interface MailAddress {
  companyName: string;
  firstName?: string;
  line: string; // one line as written on the clinic's own site, or the owner's address in test mode
}

export interface VerifiedContact {
  id: string;
  status: "verified" | "corrected" | "failed";
  normalized: string;
}

export interface MailOrder {
  id: string;
  status: string;
}

export interface MailProvider {
  name: string;
  /** true when orders are really printed and mailed */
  live: boolean;
  verify(a: MailAddress): Promise<VerifiedContact>;
  send(input: { kind: "letter" | "postcard"; toContactId: string; fromContactId: string; pdf: Buffer; description: string; idempotencyKey: string; color: boolean; mailingClass: string; addressPlacement: string; metadata: Record<string, string> }): Promise<MailOrder>;
  cancel(kind: "letter" | "postcard", id: string): Promise<void>;
}

const BASE = "https://api.postgrid.com/print-mail/v1";

export class PostGridProvider implements MailProvider {
  name = "postgrid";
  live: boolean;
  constructor(private key: string) {
    this.live = key.startsWith("live_");
  }
  private async call<T>(path: string, init: RequestInit & { idempotencyKey?: string }): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("x-api-key", this.key);
    if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);
    const res = await fetch(BASE + path, { ...init, headers });
    const json = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } };
    if (!res.ok) throw new Error(`PostGrid ${res.status}: ${json.error?.type ?? ""} ${json.error?.message ?? ""}`.trim());
    return json as T;
  }
  async verify(a: MailAddress): Promise<VerifiedContact> {
    const body = new URLSearchParams({ companyName: a.companyName, addressLine1: a.line, countryCode: "CA" });
    if (a.firstName) body.set("firstName", a.firstName);
    const c = await this.call<{ id: string; addressStatus: VerifiedContact["status"]; addressLine1: string; addressLine2?: string; city?: string; provinceOrState?: string; postalOrZip?: string }>(
      "/contacts", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    return { id: c.id, status: c.addressStatus, normalized: [c.addressLine1, c.addressLine2, c.city, c.provinceOrState, c.postalOrZip].filter(Boolean).join(", ") };
  }
  async send(i: Parameters<MailProvider["send"]>[0]): Promise<MailOrder> {
    const form = new FormData();
    form.set("to", i.toContactId);
    form.set("from", i.fromContactId);
    form.set("pdf", new Blob([new Uint8Array(i.pdf)], { type: "application/pdf" }), "piece.pdf");
    form.set("description", i.description);
    form.set("mailingClass", i.mailingClass);
    for (const [k, v] of Object.entries(i.metadata)) form.set(`metadata[${k}]`, v);
    if (i.kind === "letter") {
      form.set("color", String(i.color));
      form.set("doubleSided", "false");
      form.set("addressPlacement", i.addressPlacement);
    } else form.set("size", "6x4");
    const o = await this.call<{ id: string; status: string }>(i.kind === "letter" ? "/letters" : "/postcards", { method: "POST", body: form, idempotencyKey: i.idempotencyKey });
    return { id: o.id, status: o.status };
  }
  async cancel(kind: "letter" | "postcard", id: string) {
    await this.call(`/${kind}s/${id}`, { method: "DELETE" });
  }
}

/** Used when no key is set, and in tests: verifies by simple rules and records what would be sent. */
export class FakeProvider implements MailProvider {
  name = "fake";
  live = false;
  sent: { kind: string; to: string; from: string; description: string; bytes: number }[] = [];
  contacts = new Map<string, MailAddress>();
  async verify(a: MailAddress): Promise<VerifiedContact> {
    const id = "contact_" + crypto.randomBytes(6).toString("hex");
    this.contacts.set(id, a);
    const hasPostal = /[A-Z]\d[A-Z] ?\d[A-Z]\d/i.test(a.line);
    const failed = /undeliverable|test failed/i.test(a.line) || !/\d/.test(a.line);
    return { id, status: failed ? "failed" : hasPostal ? "verified" : "corrected", normalized: a.line.toUpperCase() };
  }
  async send(i: Parameters<MailProvider["send"]>[0]): Promise<MailOrder> {
    this.sent.push({ kind: i.kind, to: i.toContactId, from: i.fromContactId, description: i.description, bytes: i.pdf.length });
    return { id: `${i.kind}_` + crypto.randomBytes(6).toString("hex"), status: "ready" };
  }
  async cancel() {}
}

let override: MailProvider | null = null;
/** Tests inject a provider here. */
export function setMailProvider(p: MailProvider | null) {
  override = p;
}
export function mailProvider(): MailProvider {
  if (override) return override;
  const key = env().POSTGRID_API_KEY;
  return key ? new PostGridProvider(key) : new FakeProvider();
}

/** Verify and decode a PostGrid webhook (JWT, HS256, signed with the webhook secret). */
export function decodeWebhook(jwt: string, secret: string): { type: string; data: { id: string; status: string; imbStatus?: string | null; metadata?: Record<string, string> } } | null {
  const [h, p, sig] = jwt.trim().split(".");
  if (!h || !p || !sig) return null;
  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    if (header.alg !== "HS256") return null;
    const expected = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
    return JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    return null;
  }
}
