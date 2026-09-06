export const runtime = "edge";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getLive } from "@/lib/db";
import { createSupabaseServer } from "@/lib/supabase-server";

export async function GET(req: NextRequest) {
  const live = await getLive();
  const debug = req.nextUrl.searchParams.get("debug") === "1";

  let rawAll: unknown = null;
  let rawErr: unknown = null;
  let singleErr: unknown = null;
  let url = "";
  if (debug) {
    const sb = createSupabaseServer();
    url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const a = await sb
      .from("live_state")
      .select("*")
      .eq("node_id", "ADXL345-01");
    rawAll = { rows: a.data, error: a.error, count: a.data?.length };
    const b = await sb
      .from("live_state")
      .select("*")
      .eq("node_id", "ADXL345-01")
      .single();
    rawErr = b.error;
    const all = await sb.from("live_state").select("node_id, ts, updated_at");
    singleErr = all.data;
  }

  return NextResponse.json({
    ...(live || {}),
    ...(debug ? { _debug: { now: Date.now(), url, rawAll, rawErr, allNodes: singleErr } } : {}),
  });
}
