/**
 * GET /api/debug/recent — last N TraceEntry records from the chat ring buffer.
 *
 * Powers the /debug "Recent" tab. Polled every 3s by the client.
 *
 * Query params:
 *   limit      — how many entries to return (default 50, max 500)
 *   includeAll — "1" to include non-root descendants (used by the trace tree
 *                modal). Default: root entries only.
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
  const includeAll = searchParams.get("includeAll") === "1";
  return NextResponse.json({ entries: listTraceEntries(limit, { includeAll }) });
}