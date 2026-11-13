import { type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { currentOwner } from "@/lib/auth";
import { getFile } from "@/lib/storage";

/** PDF of a mail piece, owner only. */
export async function GET(req: NextRequest, ctx: RouteContext<"/portal/mail/piece/[id]">) {
  if (!(await currentOwner())) return new Response("Not found", { status: 404 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const [p] = await db()<{ pdf_path: string | null }[]>`select pdf_path from mail_pieces where id=${id}`;
  if (p?.pdf_path && req.nextUrl.searchParams.get("thumb")) {
    const png = await getFile(p.pdf_path.replace(/\.pdf$/, ".png"));
    if (!png) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, no-store" } });
  }
  const pdf = p?.pdf_path ? await getFile(p.pdf_path) : null;
  if (!pdf) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "cache-control": "private, no-store" } });
}
