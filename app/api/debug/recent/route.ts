/**
 * GET /api/debug/recent — last N TraceEntry records from the chat ring buffer.
 *
 * Powers the /debug "Recent" tab. Polled every 3s by the client.
 */

import { NextResponse } from "next/server";
import { listTraceEntries } from "@/lib/harness/trace-buffer";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const raw = Number(searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(raw) ? raw : 50;
  return NextResponse.json({ entries: listTraceEntries(limit) });
}