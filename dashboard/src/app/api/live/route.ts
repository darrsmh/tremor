export const runtime = "edge";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getLive } from "@/lib/db";
import { createSupabaseServer } from "@/lib/supabase-server";

export async function GET(req: NextRequest) {
  const live = await getLive();
  const debug = req.nextUrl.searchParams.get("debug") === "1";

  let raw: Record<string, unknown> | null = null;
  let byId: Record<string, unknown> | null = null;
  let url = "";
  if (debug) {
    const sb = createSupabaseServer();
    url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const a = await sb
      .from("live_state")
      .select("*")
      .eq("node_id", "ADXL345-01");
    raw = (a.data ?? [])[0] as Record<string, unknown>;
    const b = await sb
      .from("live_state")
      .select("*")
      .eq("node_id", "ADXL345-01")
      .single();
    byId = (b.data ?? {}) as Record<string, unknown>;
  }

  return NextResponse.json({
    ...(live || {}),
    ...(debug ? { _debug: { now: Date.now(), url, raw, byId } } : {}),
  });
}
