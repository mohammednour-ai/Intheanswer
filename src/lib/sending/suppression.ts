import { db } from "../db";

export function normalizeEmail(e: string): string {
  return e.trim().toLowerCase();
}

export function domainOf(email: string): string {
  return normalizeEmail(email).split("@")[1] ?? "";
}

/** Add an address or domain to suppression. Idempotent. */
export async function addSuppression(
  kind: "address" | "domain",
  value: string,
  reason: string,
  source: string,
): Promise<void> {
  const v = kind === "address" ? normalizeEmail(value) : value.trim().toLowerCase();
  if (!v) return;
  await db()`insert into suppressions (kind, value, reason, source) values (${kind}, ${v}, ${reason}, ${source})
             on conflict (kind, value) do nothing`;
}

/** True if the address or its domain is suppressed. Checked before every send. */
export async function isSuppressed(email: string): Promise<{ suppressed: boolean; reason?: string }> {
  const e = normalizeEmail(email);
  const d = domainOf(e);
  const rows = await db()<{ kind: string; reason: string }[]>`
    select kind::text, reason from suppressions
    where (kind = 'address' and value = ${e}) or (kind = 'domain' and value = ${d})
    limit 1`;
  if (rows.length) return { suppressed: true, reason: `${rows[0].kind}: ${rows[0].reason}` };
  return { suppressed: false };
}
