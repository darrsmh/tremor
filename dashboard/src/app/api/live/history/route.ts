export const runtime = "edge";

import { NextRequest, NextResponse } from "next/server";
import { getSamples, getSamplesWindowed } from "@/lib/db";

export async function GET(req: NextRequest) {
  const count = parseInt(req.nextUrl.searchParams.get("count") ?? "200", 10);
  const window = parseInt(req.nextUrl.searchParams.get("window") ?? "0", 10);
  if (window > 0) {
    const samples = await getSamplesWindowed(Math.min(count, 6000), Math.min(window, 3600));
    return NextResponse.json(samples);
  }
  const samples = await getSamples(Math.min(count, 6000));
  return NextResponse.json(samples);
}
