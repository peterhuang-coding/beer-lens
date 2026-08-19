/**
 * GET /api/debug/trace/[root_ts] — return every entry sharing this
 * root_ts, sorted ascending by ts. Used by the Recent tab's modal to
 * render the full call tree for one chat request.
 */

import { NextResponse } from "next/server";
import { getTreeByRoot } from "@/lib/harness/trace-buffer";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ root_ts: string }> },
): Promise<Response> {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { root_ts: raw } = await params;
  const root_ts = Number(raw);
  if (!Number.isFinite(root_ts)) {
    return NextResponse.json({ error: "invalid_root_ts" }, { status: 400 });
  }
  const tree = getTreeByRoot(root_ts);
  return NextResponse.json({ root_ts, tree });
}
