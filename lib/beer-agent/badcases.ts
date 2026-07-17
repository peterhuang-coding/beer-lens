import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type BadcaseLabel =
  | "intent_wrong"
  | "ocr_wrong"
  | "recommendation_bad"
  | "hallucination"
  | "memory_wrong"
  | "data_missing"
  | "response_bad";

export type BadcaseRecord = {
  id: string;
  traceId: string;
  userId?: string;
  conversationId?: string;
  createdAt: string;
  label: BadcaseLabel;
  note?: string;
  expected?: {
    intent?: string;
    beerName?: string;
    reply?: string;
  };
  status: "open" | "reviewed" | "fixed" | "ignored";
};

function generateBadcaseId(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `bc_${Date.now()}_${suffix}`;
}

function getBadcasesFilePath(): string {
  return path.join(process.cwd(), "data", "badcases", "badcases.json");
}

async function readBadcases(): Promise<BadcaseRecord[]> {
  try {
    const content = await readFile(getBadcasesFilePath(), "utf8");
    return JSON.parse(content) as BadcaseRecord[];
  } catch {
    return [];
  }
}

async function writeBadcases(records: BadcaseRecord[]): Promise<void> {
  const filePath = getBadcasesFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(records, null, 2) + "\n", "utf8");
}

/**
 * Given a traceId (trace_<timestamp_ms>_<suffix>), resolve the expected
 * trace file path on disk. Returns null if the traceId format is invalid.
 */
function getTraceFilePath(traceId: string): string | null {
  const match = traceId.match(/^trace_(\d+)_/);
  if (!match) return null;
  const ts = parseInt(match[1], 10);
  if (isNaN(ts)) return null;
  const dateStr = new Date(ts).toISOString().slice(0, 10);
  return path.join(process.cwd(), "data", "traces", dateStr, `${traceId}.json`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new badcase. Attempts to locate the corresponding trace file to
 * populate userId / conversationId from the trace record.
 */
export async function createBadcase(input: {
  traceId: string;
  label: BadcaseLabel;
  note?: string;
  expected?: BadcaseRecord["expected"];
}): Promise<{ ok: boolean; badcase?: BadcaseRecord; warning?: string }> {
  let warning: string | undefined;
  let userId: string | undefined;
  let conversationId: string | undefined;

  const traceFilePath = getTraceFilePath(input.traceId);
  if (traceFilePath) {
    try {
      const raw = await readFile(traceFilePath, "utf8");
      const trace = JSON.parse(raw);
      userId = trace.userId;
      conversationId = trace.conversationId;
    } catch {
      warning = "trace_not_found";
    }
  } else {
    warning = "trace_not_found";
  }

  const badcase: BadcaseRecord = {
    id: generateBadcaseId(),
    traceId: input.traceId,
    userId,
    conversationId,
    createdAt: new Date().toISOString(),
    label: input.label,
    note: input.note,
    expected: input.expected,
    status: "open",
  };

  const records = await readBadcases();
  records.push(badcase);
  await writeBadcases(records);

  const result: { ok: boolean; badcase?: BadcaseRecord; warning?: string } = {
    ok: true,
    badcase,
  };
  if (warning) result.warning = warning;
  return result;
}

/**
 * List badcases with optional filters. Each filter is compared by strict
 * equality against the corresponding field on the record.
 */
export async function listBadcases(filters?: {
  status?: string;
  label?: string;
  traceId?: string;
}): Promise<BadcaseRecord[]> {
  const records = await readBadcases();
  if (!filters) return records;
  return records.filter((r) => {
    if (filters.status !== undefined && r.status !== filters.status) return false;
    if (filters.label !== undefined && r.label !== filters.label) return false;
    if (filters.traceId !== undefined && r.traceId !== filters.traceId) return false;
    return true;
  });
}

/** Retrieve a single badcase by its id, or null when not found. */
export async function getBadcase(id: string): Promise<BadcaseRecord | null> {
  const records = await readBadcases();
  return records.find((r) => r.id === id) ?? null;
}

/**
 * Update the status and/or note of an existing badcase. Fields set to
 * undefined are left unchanged. Returns the updated record or null when
 * the id does not exist.
 */
export async function updateBadcase(
  id: string,
  update: {
    status?: BadcaseRecord["status"];
    note?: string;
  }
): Promise<BadcaseRecord | null> {
  const records = await readBadcases();
  const index = records.findIndex((r) => r.id === id);
  if (index === -1) return null;

  const updated: BadcaseRecord = {
    ...records[index],
    ...(update.status !== undefined ? { status: update.status } : {}),
    ...(update.note !== undefined ? { note: update.note } : {}),
  };
  records[index] = updated;
  await writeBadcases(records);
  return updated;
}
