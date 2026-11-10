import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { resetData, makeClinic } from "./helpers";

const OWNER = "11111111-1111-1111-1111-111111111111";
const STRANGER = "22222222-2222-2222-2222-222222222222";

async function asRole<T>(role: "anon" | "authenticated", sub: string | null, q: (tx: ReturnType<typeof db>) => Promise<T>) {
  return db().begin(async (tx) => {
    await tx`select set_config('request.jwt.claim.sub', ${sub ?? ""}, true)`;
    await tx.unsafe(`set local role ${role}`);
    return q(tx as unknown as ReturnType<typeof db>);
  }) as Promise<T>;
}

describe("row level security", () => {
  beforeAll(async () => {
    await resetData();
    await db()`update app_settings set owner_user_id = ${OWNER} where id`;
    await makeClinic();
  });
  afterAll(closeDb);

  it("enables RLS on every public table", async () => {
    const rows = await db()`select tablename from pg_tables where schemaname='public' and not rowsecurity`;
    expect(rows.map((r) => r.tablename)).toEqual([]);
  });

  it("every public table has the owner policy", async () => {
    const rows = await db()`
      select t.tablename from pg_tables t
      where t.schemaname='public'
        and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=t.tablename and p.policyname='owner_all')`;
    expect(rows).toEqual([]);
  });

  it("the owner can read and write", async () => {
    const n = await asRole("authenticated", OWNER, async (tx) => {
      await tx`update app_settings set kill_switch = kill_switch where id`;
      const r = await tx`select count(*)::int as n from clinics`;
      return r[0].n as number;
    });
    expect(n).toBe(1);
  });

  it("any other signed-in user sees nothing and cannot write", async () => {
    const n = await asRole("authenticated", STRANGER, async (tx) => (await tx`select count(*)::int as n from clinics`)[0].n);
    expect(n).toBe(0);
    await expect(
      asRole("authenticated", STRANGER, (tx) => tx`insert into suppressions (kind, value, reason, source) values ('address','x@y.z','t','t')`),
    ).rejects.toThrow(/row-level security/);
  });

  it("anonymous visitors have no table access at all", async () => {
    await expect(asRole("anon", null, (tx) => tx`select * from clinics`)).rejects.toThrow(/permission denied/);
    await expect(asRole("anon", null, (tx) => tx`select * from app_settings`)).rejects.toThrow(/permission denied/);
  });

  it("nobody is owner before the owner id is set", async () => {
    await db()`update app_settings set owner_user_id = null where id`;
    const n = await asRole("authenticated", OWNER, async (tx) => (await tx`select count(*)::int as n from clinics`)[0].n);
    expect(n).toBe(0);
  });
});
