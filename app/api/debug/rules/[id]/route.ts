/**
 * PATCH /api/debug/rules/[id] — toggle a rule's `enabled` flag.
 *
 * Body: { enabled: boolean }
 * Response: { id, enabled } | { error: "not_found" }
 *
 * The toggle is in-memory only and resets on process restart. This is
 * intentional: it makes the toggle safe to experiment with without
 * leaving side-effects on a deploy.
 */

import { NextResponse } from "next/server";
import { setRuleEnabled } from "@/lib/harness/rules";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  let body: { enabled?: unknown };
  try {
    body = (await request.json()) as { enabled?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be boolean" }, { status: 400 });
  }
  const updated = setRuleEnabled(id, body.enabled);
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ id: updated.id, enabled: updated.enabled });
}
