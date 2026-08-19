/**
 * GET /api/debug/stats — aggregate metrics from the trace ring buffer.
 *
 * Powers the /debug Stats tab. Polled every 3 s.
 */

import { NextResponse } from "next/server";
import { getStats } from "@/lib/harness/stats";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json(getStats());
}
