import crypto from "node:crypto";
import { env } from "../env";

/**
 * Print and post: PostGrid Print & Mail API (guides.postgrid.com, read 23 November 2026).
 *   base     https://api.postgrid.com/print-mail/v1, header x-api-key
 *   contacts POST /contacts: addressLine1 (a whole one-line address is parsed, "not guaranteed to be
 *            correct"), countryCode, companyName or firstName. Returns addressStatus verified |
 *            corrected | failed (only checked with a live key), addressErrors, and `live`.
 *   letters  POST /letters, multipart: to, from (contact ids), pdf (file), color, doubleSided,
 *            addressPlacement (top_first_page | insert_blank_page), mailingClass, description,
 *            metadata[...]. Idempotency-Key header, kept 24 hours. Returns id, status, live.
 *   status   ready -> printing -> processed_for_delivery -> completed | cancelled
 *   cancel   DELETE /letters/:id (only while ready)
 *   webhooks a JWT signed HS256 with the webhook's secret (default delivery)
 * A test key's orders are never printed or posted. Whether a key is live is read from the `live`
 * field of what PostGrid returns, not guessed from the key.
 */
export interface Address {
  companyName: string;
  firstName?: string;
  line: string;
}

export interface Contact {
  id: string;
  status: "verified" | "corrected" | "failed";
  normalized: string;
  errors: string | null;
  live: boolean;
}

export interface Order {
  id: string;
  status: string;
  live: boolean;
}

export interface LetterOrder {
  to: string;
  from: string;
  pdf: Buffer;
  description: string;
  idempotencyKey: string;
  mailingClass: string;
  metadata: Record<string, string>;
}

export interface MailProvider {
  name: string;
  contact(a: Address): Promise<Contact>;
  letter(o: LetterOrder): Promise<Order>;
  cancel(id: string): Promise<void>;
}

const BASE = "https://api.postgrid.com/print-mail/v1";

export class PostGrid implements MailProvider {
  name = "postgrid";
  constructor(private key: string) {}

  private async call<T>(path: string, init: RequestInit & { idempotencyKey?: string }): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("x-api-key", this.key);
    if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);
    const res = await fetch(BASE + path, { ...init, headers, signal: AbortSignal.timeout(60_000) });
    const json = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } };
    if (!res.ok) throw new Error(`PostGrid ${res.status}: ${json.error?.type ?? ""} ${json.error?.message ?? ""}`.trim());
    return json as T;
  }

  async contact(a: Address): Promise<Contact> {
    const body = new URLSearchParams({ companyName: a.companyName, addressLine1: a.line, countryCode: "CA" });
    if (a.firstName) body.set("firstName", a.firstName);
    const c = await this.call<{
      id: string; live: boolean; addressStatus: Contact["status"]; addressErrors?: string | null;
      addressLine1?: string; addressLine2?: string; city?: string; provinceOrState?: string; postalOrZip?: string;
    }>("/contacts", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    return {
      id: c.id,
      status: c.addressStatus,
      errors: c.addressErrors || null,
      live: c.live === true,
      normalized: [c.addressLine1, c.addressLine2, c.city, c.provinceOrState, c.postalOrZip].filter(Boolean).join(", "),
    };
  }

  async letter(o: LetterOrder): Promise<Order> {
    const form = new FormData();
    form.set("to", o.to);
    form.set("from", o.from);
    form.set("pdf", new Blob([new Uint8Array(o.pdf)], { type: "application/pdf" }), "letter.pdf");
    form.set("description", o.description);
    form.set("color", "true");
    form.set("doubleSided", "false");
    form.set("addressPlacement", "top_first_page");
    form.set("mailingClass", o.mailingClass);
    for (const [k, v] of Object.entries(o.metadata)) form.set(`metadata[${k}]`, v);
    const r = await this.call<{ id: string; status: string; live: boolean }>("/letters", { method: "POST", body: form, idempotencyKey: o.idempotencyKey });
    return { id: r.id, status: r.status, live: r.live === true };
  }

  async cancel(id: string): Promise<void> {
    await this.call(`/letters/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}

/** Tests: checks addresses by simple rules and records what would have been posted. */
export class FakeMail implements MailProvider {
  name = "fake";
  live = false;
  sent: (Omit<LetterOrder, "pdf"> & { bytes: number })[] = [];
  contacts = new Map<string, Address>();
  async contact(a: Address): Promise<Contact> {
    const id = "contact_" + crypto.randomBytes(6).toString("hex");
    this.contacts.set(id, a);
    const failed = /undeliverable/i.test(a.line) || !/\d/.test(a.line);
    const postal = /[A-Z]\d[A-Z] ?\d[A-Z]\d/i.test(a.line);
    return { id, status: failed ? "failed" : postal ? "verified" : "corrected", errors: failed ? "address not found" : null, live: this.live, normalized: a.line.toUpperCase() };
  }
  async letter(o: LetterOrder): Promise<Order> {
    const { pdf, ...rest } = o;
    this.sent.push({ ...rest, bytes: pdf.length });
    return { id: "letter_" + crypto.randomBytes(6).toString("hex"), status: "ready", live: this.live };
  }
  async cancel(): Promise<void> {}
}

let override: MailProvider | null = null;
/** Tests inject a provider here. */
export function setMailProvider(p: MailProvider | null): void {
  override = p;
}

/** The provider, or null when no key is set (letters can then be prepared and previewed, not posted). */
export function mailProvider(): MailProvider | null {
  if (override) return override;
  const key = env().POSTGRID_API_KEY;
  return key ? new PostGrid(key) : null;
}

export interface WebhookEvent {
  type: string;
  data: { id: string; object?: string; status?: string; live?: boolean };
}

/** Verify and decode a PostGrid webhook delivery (a JWT, HS256, signed with the webhook's secret). */
export function decodeWebhook(jwt: string, secret: string): WebhookEvent | null {
  const [h, p, sig] = jwt.trim().split(".");
  if (!h || !p || !sig) return null;
  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg?: string };
    if (header.alg !== "HS256") return null;
    const expected = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
    const ev = JSON.parse(Buffer.from(p, "base64url").toString()) as WebhookEvent;
    return ev && typeof ev.type === "string" && ev.data && typeof ev.data.id === "string" ? ev : null;
  } catch {
    return null;
  }
}
