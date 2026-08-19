/**
 * GET /api/debug/rules — list all registered hard rules with hit counts.
 *
 * Powers the /debug Rules tab. Each rule carries its current `enabled`
 * flag (mutable via PATCH /api/debug/rules/[id]).
 */

import { NextResponse } from "next/server";
import { listRules } from "@/lib/harness/rules";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rules = listRules().map((r) => ({
    id: r.id,
    stage: r.stage,
    enabled: r.enabled,
    priority: r.priority,
    description: r.description,
  }));
  return NextResponse.json({ rules });
}
