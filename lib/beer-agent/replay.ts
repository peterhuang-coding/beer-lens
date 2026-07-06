import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TraceRecord } from "./dialog-types";
import type { BadcaseRecord } from "./badcases";
import { getBadcase } from "./badcases";

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
): Promise<TraceRecord | null> {
  const filePath = getTraceFilePath(traceId);
  if (!filePath) return null;
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as TraceRecord;
  } catch {
    return null;
  }
}

/**
 * Build a Chinese-language analysis prompt for replaying and diagnosing
 * a badcase.
 */
export function buildReplayPrompt(
  trace: TraceRecord,
  badcase?: BadcaseRecord
): string {
  const lines: string[] = [];

  lines.push("这是一个 Beer Lens badcase。");
  lines.push("");
  lines.push(`用户输入：${trace.input.lastUserText}`);
  lines.push("");
  lines.push(
    `系统识别意图：${trace.intentResult.intent} (置信度: ${trace.intentResult.confidence})`
  );
  lines.push("");
  lines.push(`实际回复：${trace.output.reply}`);
  lines.push("");

  if (badcase) {
    lines.push(`badcase 标签：${badcase.label}`);
    lines.push("");

    if (badcase.note) {
      lines.push(`备注：${badcase.note}`);
      lines.push("");
    }

    if (badcase.expected?.intent) {
      lines.push(`期望意图：${badcase.expected.intent}`);
    }
    if (badcase.expected?.reply) {
      lines.push(`期望回复：${badcase.expected.reply}`);
    }
    if (badcase.expected?.intent || badcase.expected?.reply) {
      lines.push("");
    }
  }

  lines.push("请判断错误发生在哪一层：");
  lines.push("- intent classifier");
  lines.push("- dispatcher");
  lines.push("- memory");
  lines.push("- OCR");
  lines.push("- retrieval");
  lines.push("- scoring");
  lines.push("- response generation");
  lines.push("- postprocess");
  lines.push("");
  lines.push("请提出最小修复方案。");

  return lines.join("\n");
}

/**
 * Convenience function that loads a badcase by id, reads its linked trace,
 * and returns a replay analysis prompt.
 *
 * Returns null if the badcase is not found.
 */
export async function getReplayData(badcaseId: string): Promise<string | null> {
  const badcase = await getBadcase(badcaseId);
  if (!badcase) return null;

  const trace = await readTraceByTraceId(badcase.traceId);
  if (!trace) return null;

  return buildReplayPrompt(trace, badcase);
}
