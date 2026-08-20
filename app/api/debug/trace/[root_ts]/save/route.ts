/**
 * POST /api/debug/trace/[root_ts]/save — persist a request's full call tree
 * to data/traces/{root_ts}.jsonl (one JSON entry per line) so it survives
 * a server restart / buffer eviction (default 500-entry FIFO).
 *
 * Returns { ok, path, bytes } on success, 404 if the tree is no longer in
 * the buffer, 403 if the request is not from a debug-allowed source.
 *
 * Idempotent — saving the same root_ts twice overwrites the file.
 */

import { NextResponse } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getTreeByRoot } from "@/lib/harness/trace-buffer";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
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
  if (tree.length === 0) {
    return NextResponse.json(
      { error: "not_in_buffer", message: "Trace has been evicted or never existed. Increase TRACE_BUFFER_MAX or save within the FIFO window." },
      { status: 404 },
    );
  }

  const dir = path.join(process.cwd(), "data", "traces");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${root_ts}.jsonl`);

  // One JSON entry per line, sorted by ts ascending (so a `cat`+`jq` replay
  // is stable). Trim unknown / non-serialisable fields.
  const body = tree
    .map((e) => JSON.stringify({
      ts: e.ts,
      ts_iso: e.ts_iso,
      root_ts: e.root_ts,
      parent_ts: e.parent_ts,
      stage: e.stage,
      duration_ms: e.duration_ms,
      skill_id: e.stage_skill_id ?? e.skill_id ?? undefined,
      message: e.message || undefined,
      source: e.source || undefined,
      ok: e.ok,
      error_code: e.error_code,
      candidate_count: e.candidate_count,
      has_image: e.has_image,
      reason: e.reason,
      decision: e.decision,
    }))
    .join("\n") + "\n";

  try {
    await writeFile(filePath, body, "utf8");
  } catch (err) {
    return NextResponse.json(
      { error: "write_failed", message: String((err as Error).message ?? err) },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    path: `data/traces/${root_ts}.jsonl`,
    bytes: body.length,
    entries: tree.length,
  });
}