import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { currentOwner } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const sb = await supabaseServer();
  if (code && sb) {
    await sb.auth.exchangeCodeForSession(code);
    const owner = await currentOwner();
    if (!owner) {
      await sb.auth.signOut();
      return NextResponse.redirect(new URL("/portal/login", request.url));
    }
  }
  return NextResponse.redirect(new URL("/portal", request.url));
}
