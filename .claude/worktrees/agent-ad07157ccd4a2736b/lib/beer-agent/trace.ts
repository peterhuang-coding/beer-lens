import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { TraceRecord } from "./dialog-types";

export function createTraceId(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `trace_${Date.now()}_${suffix}`;
}

export async function writeTrace(record: TraceRecord): Promise<void> {
  try {
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dirPath = path.join(process.cwd(), "data", "traces", dateStr);
    await mkdir(dirPath, { recursive: true });
    const filePath = path.join(dirPath, `${record.traceId}.json`);
    await writeFile(filePath, JSON.stringify(record, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn("[trace] writeTrace failed:", err);
    if (record.debug) {
      if (!record.debug.warnings) {
        record.debug.warnings = [];
      }
      record.debug.warnings.push("trace_write_failed");
    }
  }
}
