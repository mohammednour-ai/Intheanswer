import { Resend } from "resend";
import { env } from "../env";

/**
 * Email provider (Resend). Everything that touches the provider goes through
 * this interface so tests and dry runs never reach the network.
 */
export interface OutboundMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; content: Buffer }[];
  /** Safe to retry: the provider drops a repeat with the same key. */
  idempotencyKey: string;
}

export interface InboundMail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  messageId: string | null;
  headers: Record<string, string>;
  receivedAt: Date;
}

export interface DomainState {
  status: string; // verified, pending, failed, ...
  records: { record: string; name: string; type: string; status: string }[];
}

export interface MailEvent {
  type: string;
  createdAt: Date;
  /** Provider id of the email the event is about (sent or received). */
  emailId: string | null;
  to: string[];
  from: string | null;
  bounceType?: string;
  detail?: string;
  raw: unknown;
}

export interface MailProvider {
  send(m: OutboundMail): Promise<{ id: string }>;
  getInbound(id: string): Promise<InboundMail>;
  domainState(): Promise<DomainState | null>;
  /** Throws when the signature does not match. */
  verifyWebhook(payload: string, headers: Headers): MailEvent;
}

function parseEvent(e: { type: string; created_at: string; data: Record<string, unknown> }): MailEvent {
  const d = e.data ?? {};
  const bounce = d.bounce as { type?: string; subType?: string; message?: string } | undefined;
  const failed = d.failed as { reason?: string } | undefined;
  const to = Array.isArray(d.to) ? (d.to as string[]) : typeof d.to === "string" ? [d.to] : [];
  return {
    type: e.type,
    createdAt: new Date(e.created_at),
    emailId: (d.email_id as string) ?? (d.id as string) ?? null,
    to,
    from: (d.from as string) ?? null,
    bounceType: bounce?.type,
    detail: bounce?.message ?? failed?.reason,
    raw: e,
  };
}

function htmlToText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function resendProvider(): MailProvider {
  const e = env();
  const client = () => {
    if (!e.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
    return new Resend(e.RESEND_API_KEY);
  };
  return {
    async send(m) {
      const { data, error } = await client().emails.send(
        {
          from: m.from,
          to: m.to,
          subject: m.subject,
          text: m.text,
          ...(m.html ? { html: m.html } : {}),
          ...(m.replyTo ? { replyTo: m.replyTo } : {}),
          ...(m.headers ? { headers: m.headers } : {}),
          ...(m.attachments?.length ? { attachments: m.attachments } : {}),
        },
        { idempotencyKey: m.idempotencyKey },
      );
      if (error || !data) throw new Error(`resend: ${error?.name ?? "error"}: ${error?.message ?? "no response"}`);
      return { id: data.id };
    },
    async getInbound(id) {
      const { data, error } = await client().emails.receiving.get(id);
      if (error || !data) throw new Error(`resend inbound: ${error?.message ?? "not found"}`);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(data.headers ?? {})) headers[k.toLowerCase()] = String(v);
      return {
        id: data.id,
        from: data.from,
        to: data.to,
        subject: data.subject ?? "",
        text: data.text ?? htmlToText(data.html ?? ""),
        messageId: data.message_id ?? null,
        headers,
        receivedAt: new Date(data.created_at),
      };
    },
    async domainState() {
      if (!e.RESEND_API_KEY || !e.RESEND_DOMAIN_ID) return null;
      const { data, error } = await client().domains.get(e.RESEND_DOMAIN_ID);
      if (error || !data) throw new Error(`resend domain: ${error?.message ?? "not found"}`);
      const raw = (data as unknown as { records?: DomainState["records"] }).records ?? [];
      return { status: data.status, records: raw.map((r) => ({ record: r.record, name: r.name, type: r.type, status: r.status })) };
    },
    verifyWebhook(payload, headers) {
      if (!e.RESEND_WEBHOOK_SECRET) throw new Error("RESEND_WEBHOOK_SECRET is not set");
      // the signature check needs no API key
      const ev = new Resend(e.RESEND_API_KEY ?? "re_unused").webhooks.verify({
        payload,
        headers: { id: headers.get("svix-id") ?? "", timestamp: headers.get("svix-timestamp") ?? "", signature: headers.get("svix-signature") ?? "" },
        webhookSecret: e.RESEND_WEBHOOK_SECRET,
      });
      return parseEvent(ev as never);
    },
  };
}

const g = globalThis as unknown as { __mail?: MailProvider };

export function mail(): MailProvider {
  if (!g.__mail) g.__mail = resendProvider();
  return g.__mail;
}

/** Tests: swap in a fake provider (pass null to restore the real one). */
export function setMailProvider(p: MailProvider | null) {
  g.__mail = p ?? undefined;
}

/** "Name <address>" for the From header. */
export function fromHeader(): string {
  const e = env();
  const name = (e.MAIL_FROM_NAME || e.OWNER_NAME || "").replace(/["\r\n<>]/g, "").trim();
  return name && !name.startsWith("[") ? `"${name}" <${e.MAIL_FROM}>` : e.MAIL_FROM;
}

/** Bare address out of "Name <a@b>" or "a@b". */
export function addressOf(s: string): string {
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}
