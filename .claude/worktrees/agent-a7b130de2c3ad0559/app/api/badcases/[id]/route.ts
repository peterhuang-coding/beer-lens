import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getBadcase, updateBadcase } from "@/lib/beer-agent/badcases";
import type { BadcaseRecord } from "@/lib/beer-agent/badcases";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

/**
 * Resolve the expected trace file path on disk from a traceId.
 * Returns null if the traceId format is invalid.
 */
function getTraceFilePath(traceId: string): string | null {
  const match = traceId.match(/^trace_(\d+)_/);
  if (!match) return null;
  const ts = parseInt(match[1], 10);
  if (isNaN(ts)) return null;
  const dateStr = new Date(ts).toISOString().slice(0, 10);
  return path.join(process.cwd(), "data", "traces", dateStr, `${traceId}.json`);
}

/**
 * Read a trace record from disk by traceId. Returns null when the file does
 * not exist or the format is invalid.
 */
async function readTraceByTraceId(
  traceId: string
): Promise<Record<string, unknown> | null> {
  const filePath = getTraceFilePath(traceId);
  if (!filePath) return null;
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const badcase = await getBadcase(id);
  if (!badcase) {
    return NextResponse.json(
      { ok: false, error: "badcase_not_found" },
      { status: 404 }
    );
  }

  const trace = await readTraceByTraceId(badcase.traceId);

  return NextResponse.json({ badcase, trace: trace ?? null });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  let body: { status?: string; note?: string };
  try {
    body = (await request.json()) as { status?: string; note?: string };
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 }
    );
  }

  if (!body.status && !body.note) {
    return NextResponse.json(
      { ok: false, error: "nothing_to_update" },
      { status: 400 }
    );
  }

  const validStatuses: Array<BadcaseRecord["status"]> = [
    "open",
    "reviewed",
    "fixed",
    "ignored",
  ];
  if (body.status && !validStatuses.includes(body.status as BadcaseRecord["status"])) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_status",
        valid: validStatuses,
      },
      { status: 400 }
    );
  }

  const update: { status?: BadcaseRecord["status"]; note?: string } = {};
  if (body.status) update.status = body.status as BadcaseRecord["status"];
  if (body.note !== undefined) update.note = body.note;

  const updated = await updateBadcase(id, update);
  if (!updated) {
    return NextResponse.json(
      { ok: false, error: "badcase_not_found" },
      { status: 404 }
    );
  }

  return NextResponse.json(updated);
}
