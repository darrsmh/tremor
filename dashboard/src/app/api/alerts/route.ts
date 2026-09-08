export const runtime = "edge";

import { NextRequest, NextResponse } from "next/server";
import { pushAlert, updateLive, getAlerts, DEFAULT_NODE_ID } from "@/lib/db";

function verifyKey(req: NextRequest) {
  return req.headers.get("x-api-key") === process.env.API_KEY;
}

export async function GET(req: NextRequest) {
  const count = parseInt(req.nextUrl.searchParams.get("count") ?? "20", 10);
  const alerts = await getAlerts(Math.min(count, 50));
  return NextResponse.json(alerts);
}

export async function POST(req: NextRequest) {
  if (!verifyKey(req))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();

  // Alert insert and live_state update are independent — run concurrently.
  await Promise.all([
    pushAlert(body),
    updateLive({
      node_id:        body.node_id ?? DEFAULT_NODE_ID,
      last_alert_pga: body.pga,
      last_alert_ts:  body.ts_ms,
      last_alert_snr: body.snr_db,
    }),
  ]);

  return NextResponse.json({ ok: true });
}
