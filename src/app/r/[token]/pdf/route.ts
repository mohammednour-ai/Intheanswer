import { type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { currentOwner } from "@/lib/auth";
import { getFile } from "@/lib/storage";

export const maxDuration = 60;

export async function GET(req: NextRequest, ctx: RouteContext<"/r/[token]/pdf">) {
  const { token } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return new Response("Not found", { status: 404 });
  const [r] = await db()<{ pdf_path: string | null; data: { verified?: boolean; clinic?: { name?: string } } }[]>`
    select pdf_path, data from reports where token=${token}`;
  if (!r?.pdf_path) return new Response("Not found", { status: 404 });
  if (r.data?.verified === false && !(await currentOwner())) return new Response("Not found", { status: 404 });
  const pdf = await getFile(r.pdf_path);
  if (!pdf) return new Response("Not found", { status: 404 });
  const name = (r.data?.clinic?.name ?? "report").replace(/[^A-Za-z0-9 ]/g, "").trim().replace(/\s+/g, "-");
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="In-The-Answer-${name}.pdf"`,
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "private, no-store",
    },
  });
}
