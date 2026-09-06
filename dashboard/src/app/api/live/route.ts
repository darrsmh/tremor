export const runtime = "edge";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getLive } from "@/lib/db";

export async function GET(req: NextRequest) {
  const live = await getLive();
  const debug = req.nextUrl.searchParams.get("debug") === "1";
  return NextResponse.json({
    ...(live || {}),
    ...(debug
      ? { _debug: { now: Date.now(), ts_now: new Date().toISOString() } }
      : {}),
  });
}
