import { currentOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { htmlToPdf } from "@/lib/reports/pdf";

export const runtime = "nodejs";
export const maxDuration = 60;

/** The letter as PostGrid receives it (rendered from the stored HTML). Owner only. */
export async function GET(_req: Request, ctx: RouteContext<"/portal/letters/[id]/pdf">) {
  if (!(await currentOwner())) return new Response("Not found", { status: 404 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const [l] = await db()<{ html: string; code: string }[]>`select html, code from letters where id = ${id}`;
  if (!l) return new Response("Not found", { status: 404 });
  const pdf = await htmlToPdf(l.html);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="letter-${l.code}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
