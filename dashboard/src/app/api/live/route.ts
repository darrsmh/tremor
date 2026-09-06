export const runtime = "edge";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getLive } from "@/lib/db";

export async function GET() {
  const live = await getLive();
  return NextResponse.json(live || {});
}
