import { type NextRequest } from "next/server";
import { completeConnection } from "@/lib/reviews/gbp";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return new Response("Missing authorization.", { status: 400 });
  try {
    const r = await completeConnection(state, code);
    return new Response(
      r.location ? "Thank you. Your Google Business Profile is connected. You can close this page." : "Connected, but no business location was found on this Google account. We will be in touch.",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  } catch {
    return new Response("The connection could not be completed. Please try the link again.", { status: 400 });
  }
}
