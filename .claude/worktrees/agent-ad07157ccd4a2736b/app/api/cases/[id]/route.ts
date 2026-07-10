import { NextResponse } from "next/server";
import { getCase, updateCase } from "@/lib/beer-agent/cases";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

// Read trace file from disk
async function findTrace(traceId: string): Promise<any | null> {
  try {
    // Parse timestamp from traceId: trace_{timestamp}_{suffix}
    const m = traceId.match(/^trace_(\d+)_/);
    if (!m) return null;
    const ts = parseInt(m[1], 10);
    const d = new Date(ts);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const tracePath = path.join(process.cwd(), "data", "traces", `${yyyy}-${mm}-${dd}`, `${traceId}.json`);
    const raw = await readFile(tracePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const c = await getCase(id);
  if (!c) return NextResponse.json({ ok: false, error: "case_not_found" }, { status: 404 });

  const trace = await findTrace(c.traceId);
  return NextResponse.json({ case: c, trace });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  try {
    const body = await request.json();
    const updated = await updateCase(id, body);
    if (!updated) return NextResponse.json({ ok: false, error: "case_not_found" }, { status: 404 });
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
}
