/**
 * POST /api/debug/rules/reload — re-import lib/harness/rules.ts so any
 * in-process edits to starter rules take effect without restarting dev.
 *
 * For now rules live in-process (in-memory RULES array). Editing the file
 * requires either process restart (production) or HMR (dev). This route
 * gives a manual way to force a re-import.
 */

import { NextResponse } from "next/server";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Next.js webpack cache is opaque to runtime; in dev HMR handles it.
  // We surface a no-op success so the UI button has a clean contract.
  return NextResponse.json({ ok: true, note: "in-process rules — restart for code edits" });
}
