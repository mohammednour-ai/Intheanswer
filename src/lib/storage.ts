import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { env } from "./env";

/**
 * Private file storage for report PDFs. Supabase Storage (private bucket) in
 * production; a local ./output folder when Supabase is not configured, in
 * development and tests only (production refuses to write to local disk).
 */
function supabaseAdmin() {
  const e = env();
  if (!e.NEXT_PUBLIC_SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

export async function putFile(key: string, data: Buffer, contentType: string): Promise<string> {
  const sb = supabaseAdmin();
  if (sb) {
    const { error } = await sb.storage.from(env().SUPABASE_STORAGE_BUCKET).upload(key, data, { contentType, upsert: true });
    if (error) throw new Error(`storage upload failed: ${error.message}`);
    return `supabase:${key}`;
  }
  // The local folder is for development only: on a serverless host the disk
  // is temporary and not shared, so a report saved there would silently vanish.
  if (env().NODE_ENV === "production") {
    throw new Error("report storage is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (reports are not written to local disk in production)");
  }
  const file = path.join(process.cwd(), "output", key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  return `local:${key}`;
}

export async function getFile(ref: string): Promise<Buffer | null> {
  const [kind, key] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
  if (kind === "supabase") {
    const sb = supabaseAdmin();
    if (!sb) return null;
    const { data, error } = await sb.storage.from(env().SUPABASE_STORAGE_BUCKET).download(key);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }
  try {
    return await fs.readFile(path.join(process.cwd(), "output", key));
  } catch {
    return null;
  }
}
