import postgres from "postgres";
import { env } from "./env";

/**
 * Server-side Postgres connection. Uses the database owner role (Supabase
 * "postgres" via the pooler), which is not subject to RLS. Only server code
 * that has already checked the owner session, or background jobs, may use it.
 */
type Sql = postgres.Sql<{ numeric: number }>;

const g = globalThis as unknown as { __sql?: Sql };

export function db(): Sql {
  if (!g.__sql) {
    g.__sql = postgres(env().DATABASE_URL, {
      max: 5,
      idle_timeout: 20,
      prepare: false, // required for the Supabase transaction pooler
      onnotice: () => {},
      types: {
        // return numerics as JS numbers (amounts are small)
        numeric: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
      },
    });
  }
  return g.__sql;
}

export async function closeDb() {
  if (g.__sql) {
    await g.__sql.end({ timeout: 5 });
    g.__sql = undefined;
  }
}

export type { Sql };
