import { promises as dns } from "node:dns";
import { db } from "../db";
import { env } from "../env";
import { mail } from "../adapters/mail";
import type { JobContext } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { registerScheduled } from "../schedule/tick";

/**
 * DNS gate: sending is refused until the sending domain has SPF, DKIM and a
 * DMARC policy. When the Resend domain id is configured, Resend's own
 * verification is the answer for SPF and DKIM; otherwise the records are read
 * from public DNS. DMARC is always read from DNS.
 */
export interface DnsCheck {
  ok: boolean;
  domain: string;
  checkedAt: string;
  spf: { ok: boolean; detail: string };
  dkim: { ok: boolean; detail: string };
  dmarc: { ok: boolean; detail: string };
  provider: { status: string } | null;
}

export type TxtResolver = (name: string) => Promise<string[]>;

const liveTxt: TxtResolver = async (name) => {
  try {
    return (await dns.resolveTxt(name)).map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
};

/** Registrable domain, good enough for .ca / .com names (mail.example.ca -> example.ca). */
export function orgDomain(domain: string): string {
  return domain.split(".").slice(-2).join(".");
}

export async function checkDnsRecords(domain: string, txt: TxtResolver = liveTxt): Promise<Pick<DnsCheck, "spf" | "dkim" | "dmarc">> {
  // Resend sets the return path on send.<domain>; a plain SPF record on the domain also counts.
  const spfRows = [...(await txt(`send.${domain}`)), ...(await txt(domain))].filter((r) => /^v=spf1\b/i.test(r));
  const dkimRows = (await txt(`resend._domainkey.${domain}`)).filter((r) => /\bp=[A-Za-z0-9+/]{20,}/.test(r));
  let dmarcAt = `_dmarc.${domain}`;
  let dmarcRows = (await txt(dmarcAt)).filter((r) => /^v=DMARC1\b/i.test(r));
  if (!dmarcRows.length && orgDomain(domain) !== domain) {
    dmarcAt = `_dmarc.${orgDomain(domain)}`;
    dmarcRows = (await txt(dmarcAt)).filter((r) => /^v=DMARC1\b/i.test(r));
  }
  return {
    spf: spfRows.length ? { ok: true, detail: spfRows[0] } : { ok: false, detail: `no SPF record (v=spf1) on send.${domain} or ${domain}` },
    dkim: dkimRows.length ? { ok: true, detail: `resend._domainkey.${domain} has a key` } : { ok: false, detail: `no DKIM key at resend._domainkey.${domain}` },
    dmarc: dmarcRows.length
      ? { ok: true, detail: `${dmarcAt}: ${dmarcRows[0]}` }
      : { ok: false, detail: `no DMARC record (v=DMARC1) at _dmarc.${domain} or _dmarc.${orgDomain(domain)}` },
  };
}

export async function checkDns(txt: TxtResolver = liveTxt): Promise<DnsCheck> {
  const domain = env().SENDING_DOMAIN.toLowerCase();
  const rec = await checkDnsRecords(domain, txt);
  let provider: DnsCheck["provider"] = null;
  try {
    const st = await mail().domainState();
    if (st) {
      provider = { status: st.status };
      const verified = st.status === "verified";
      // Resend checks the exact records it issued: trust it over the generic lookup.
      const has = (name: string) => st.records.some((r) => r.record === name && r.status === "verified");
      rec.spf = { ok: verified || has("SPF"), detail: `Resend: SPF ${verified || has("SPF") ? "verified" : st.status}` };
      rec.dkim = { ok: verified || has("DKIM"), detail: `Resend: DKIM ${verified || has("DKIM") ? "verified" : st.status}` };
    }
  } catch (e) {
    provider = { status: `could not be read: ${(e as Error).message}` };
  }
  const check: DnsCheck = { ok: rec.spf.ok && rec.dkim.ok && rec.dmarc.ok, domain, checkedAt: new Date().toISOString(), ...rec, provider };
  const sql = db();
  await sql`update app_settings set dns_verified=${check.ok}, dns_checked_at=now(), dns_detail=${sql.json(check as never)}, updated_at=now() where id`;
  return check;
}

register("check_dns", async (ctx: JobContext) => {
  const c = await checkDns();
  await ctx.log("dns check", c);
  return { ok: c.ok };
});

// Records can be removed by mistake: look again every day so the gate closes if they go.
registerScheduled({ name: "dns_check", every: "day", atHour: 7, run: async () => ({ ok: (await checkDns()).ok }) });
