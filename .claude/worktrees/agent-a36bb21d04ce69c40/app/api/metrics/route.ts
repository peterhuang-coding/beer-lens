import { NextResponse } from "next/server";
import { getMetricsSnapshot } from "@/lib/beer-agent/monitor/metrics";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const snapshot = getMetricsSnapshot();
  return NextResponse.json(snapshot);
}
