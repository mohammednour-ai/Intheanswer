import { redirect } from "next/navigation";
import { db } from "./db";
import { env } from "./env";
import { supabaseServer } from "./supabase/server";

export interface Owner {
  userId: string;
  email: string;
  devBypass: boolean;
}

export function devBypassAllowed(): boolean {
  const e = env();
  return e.NODE_ENV !== "production" && e.PORTAL_DEV_BYPASS === "1";
}

/**
 * Returns the owner if the current request is signed in as the one allowed
 * account, else null. The first successful sign-in with OWNER_EMAIL records
 * the user id in app_settings; after that only that exact id is accepted.
 */
export async function currentOwner(): Promise<Owner | null> {
  if (devBypassAllowed()) {
    return { userId: "00000000-0000-0000-0000-000000000000", email: env().OWNER_EMAIL, devBypass: true };
  }
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data } = await sb.auth.getUser();
  const user = data.user;
  if (!user?.email) return null;
  if (user.email.toLowerCase() !== env().OWNER_EMAIL.toLowerCase()) return null;
  const sql = db();
  const [s] = await sql<{ owner_user_id: string | null }[]>`select owner_user_id from app_settings where id`;
  if (!s.owner_user_id) {
    await sql`update app_settings set owner_user_id = ${user.id}, owner_email = ${user.email} where id and owner_user_id is null`;
  } else if (s.owner_user_id !== user.id) {
    return null;
  }
  return { userId: user.id, email: user.email, devBypass: false };
}

export async function requireOwner(): Promise<Owner> {
  const o = await currentOwner();
  if (!o) redirect("/portal/login");
  return o;
}
