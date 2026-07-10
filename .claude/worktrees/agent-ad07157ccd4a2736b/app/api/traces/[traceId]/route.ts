import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ traceId: string }> }
): Promise<Response> {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { traceId } = await params;

  const match = traceId.match(/^trace_(\d+)_/);
  if (!match) {
    return NextResponse.json(
      { ok: false, error: "trace_not_found" },
      { status: 404 }
    );
  }

  const ts = parseInt(match[1], 10);
  if (isNaN(ts)) {
    return NextResponse.json(
      { ok: false, error: "trace_not_found" },
      { status: 404 }
    );
  }

  const dateStr = new Date(ts).toISOString().slice(0, 10);
  const filePath = path.join(
    process.cwd(),
    "data",
    "traces",
    dateStr,
    `${traceId}.json`
  );

  try {
    const content = await readFile(filePath, "utf8");
    const trace = JSON.parse(content);
    return NextResponse.json(trace);
  } catch {
    return NextResponse.json(
      { ok: false, error: "trace_not_found" },
      { status: 404 }
    );
  }
}
