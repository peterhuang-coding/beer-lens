/**
 * Case recording — every turn gets a case record for raw data analysis.
 * Labels are optional; unlabeled cases are just "recorded" for later review.
 *
 * Image-turn cases automatically create a matching raw data task in
 * data/raw-data/tasks.json — this bridges user-uploaded images into
 * the raw annotation workflow.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RootCause, TraceRecord } from "./dialog-types";
import type { VqaTask, RawQuestion } from "../raw-pipeline/types";

export type CaseLabel =
  | "good"
  | "intent_wrong"
  | "ocr_wrong"
  | "recommendation_bad"
  | "hallucination"
  | "memory_wrong"
  | "data_missing"
  | "response_bad"
  | null;

export type CaseRecord = {
  id: string;
  traceId: string;
  conversationId?: string;
  createdAt: string;
  /** User input summary */
  input: {
    text: string;
    hasImage: boolean;
    imageName?: string;
  };
  /** Detected intent */
  intent: { name: string; confidence: number };
  /** Source of the intent classification */
  intentSource?: string;
  /** Route reason for debugging */
  intentRouteReason?: string;
  /** Diagnosis from intent classifier (for badcase analysis) */
  intentDiagnosis?: Record<string, unknown>;
  /** Reply preview (first 300 chars) */
  replyPreview: string;
  /** Candidate count */
  candidateCount: number;
  /** Optional label — null = unlabeled */
  label: CaseLabel;
  /** Optional note */
  note?: string;
  /** Expected behavior override */
  expected?: {
    intent?: string;
    reply?: string;
    beerName?: string;
  };
  /** Review status */
  status: "unlabeled" | "reviewed" | "fixed" | "ignored";
  /** Warnings from guardrails */
  warnings: string[];
  /** Optional root cause classification for diagnosis. */
  rootCause?: RootCause;
};

const CASES_PATH = path.join(process.cwd(), "data", "cases.json");
const VQA_TASKS_PATH = path.join(process.cwd(), "data", "raw-data", "tasks.json");

/** Default VQA questions reused for user-upload image tasks */
const RAW_DEFAULT_QUESTIONS: RawQuestion[] = [
  { id: "is_beer_label", type: "yesno", prompt: "这张图是否包含啤酒瓶/罐/酒标？" },
  { id: "beer_name", type: "text", prompt: "图中最可能的啤酒名称是什么？" },
  { id: "brand", type: "text", prompt: "图中品牌是什么？" },
  {
    id: "style", type: "select", prompt: "能否识别风格？",
    options: ["IPA", "Stout", "Lager", "Sour", "Pilsner", "Porter", "Wheat", "Saison", "其他", "无法判断"],
  },
  { id: "abv", type: "text", prompt: "能否识别 ABV？" },
  { id: "visible_text", type: "text", prompt: "OCR/肉眼能看到哪些关键文字？" },
  {
    id: "image_quality", type: "select", prompt: "图片质量是否适合做识别测试？",
    options: ["清晰可用", "勉强可读", "模糊不清", "完全不适用"],
  },
];

async function readCases(): Promise<CaseRecord[]> {
  try {
    const raw = await readFile(CASES_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeCases(cases: CaseRecord[]): Promise<void> {
  await mkdir(path.dirname(CASES_PATH), { recursive: true });
  await writeFile(CASES_PATH, JSON.stringify(cases, null, 2) + "\n");
}

// ── Auto-create case from trace record ──

export async function createCaseFromTrace(trace: TraceRecord): Promise<CaseRecord> {
  let rootCause: RootCause | undefined;
  if (trace.planner?.diagnostics?.fallbackUsed) {
    rootCause = "planner";
  } else if (trace.route?.handler === "planner" && trace.errors?.length > 0) {
    rootCause = "tool_route";
  } else if (trace.errors?.length > 0) {
    // Infer root cause from error model/provider info
    for (const err of trace.errors) {
      if (err.provider && parseInt(err.errorCode ?? "0") >= 400) {
        rootCause = "model";
        break;
      }
    }
  }

  const record: CaseRecord = {
    id: `case_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    traceId: trace.traceId,
    conversationId: trace.conversationId,
    createdAt: new Date().toISOString(),
    input: {
      text: trace.input.lastUserText,
      hasImage: trace.input.hasImage,
      imageName: trace.input.imageName,
    },
    intent: {
      name: trace.intentResult.intent,
      confidence: trace.intentResult.confidence,
    },
    intentSource: trace.intentResult.source,
    intentRouteReason: trace.intentResult.routeReason,
    intentDiagnosis: trace.intentResult.diagnosis as Record<string, unknown> | undefined,
    replyPreview: trace.output.reply.slice(0, 300),
    candidateCount: trace.output.candidateCount,
    label: null,
    status: "unlabeled",
    warnings: trace.debug?.warnings ?? [],
    rootCause,
  };

  const cases = await readCases();
  cases.unshift(record);

  // Keep max 500 cases
  if (cases.length > 500) cases.length = 500;

  await writeCases(cases);

  // ── Sync image cases to raw data tasks (fire-and-forget) ──
  if (trace.input.hasImage && trace.input.imageUrl) {
    syncCaseToVqa(trace, record.id).catch((err) => {
      console.warn("[cases] raw data task sync failed:", err);
    });
  }

  return record;
}

/** Create or update a raw data task for an image-bearing case. */
async function syncCaseToVqa(trace: TraceRecord, caseId: string): Promise<void> {
  const taskId = `raw_${caseId.replace("case_", "case_")}_${Date.now().toString(36)}`;

  const task: VqaTask = {
    id: taskId,
    source: "user_upload",
    sourceUrl: `case://${caseId}`,
    imageUrl: trace.input.imageUrl!,
    title: trace.input.lastUserText.slice(0, 120),
    candidateBeerName: "",
    questions: RAW_DEFAULT_QUESTIONS,
    labels: {},
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let existing: VqaTask[] = [];
  try {
    const raw = await readFile(VQA_TASKS_PATH, "utf8");
    existing = JSON.parse(raw);
  } catch {
    existing = [];
  }

  // Skip if same image URL + conversation already exists
  const isDuplicate = existing.some(
    (t) => t.imageUrl === task.imageUrl && t.sourceUrl?.startsWith("case://"),
  );
  if (isDuplicate) return;

  await mkdir(path.dirname(VQA_TASKS_PATH), { recursive: true });
  existing.unshift(task);
  await writeFile(VQA_TASKS_PATH, JSON.stringify(existing, null, 2) + "\n");
}

/** Sync a case label change to the corresponding raw data task.
 *  - label set to non-null → status = "labeled"
 *  - label cleared (null) → status = "pending" */
export async function syncCaseLabelToVqa(
  caseId: string,
  label: CaseLabel,
): Promise<void> {
  const sourceUrl = `case://${caseId}`;
  const newStatus = label != null ? "labeled" : "pending";

  let existing: VqaTask[] = [];
  try {
    const raw = await readFile(VQA_TASKS_PATH, "utf8");
    existing = JSON.parse(raw);
  } catch {
    return; // No raw data tasks file — nothing to sync
  }

  const taskIdx = existing.findIndex((t) => t.sourceUrl === sourceUrl);
  if (taskIdx === -1) return; // No matching raw data task

  existing[taskIdx].status = newStatus;
  existing[taskIdx].updatedAt = new Date().toISOString();

  await mkdir(path.dirname(VQA_TASKS_PATH), { recursive: true });
  await writeFile(VQA_TASKS_PATH, JSON.stringify(existing, null, 2) + "\n");
}

// ── List with filters ──

export async function listCases(filters?: {
  status?: string;
  label?: string;
  search?: string;
}): Promise<CaseRecord[]> {
  let cases = await readCases();
  if (filters?.status) {
    cases = cases.filter(c => c.status === filters.status);
  }
  if (filters?.label) {
    cases = cases.filter(c => c.label === filters.label);
  }
  if (filters?.search) {
    const query = filters.search.toLowerCase();
    cases = cases.filter(c =>
      c.input.text.toLowerCase().includes(query) ||
      c.replyPreview.toLowerCase().includes(query)
    );
  }
  return cases;
}

// ── Get one ──

export async function getCase(id: string): Promise<CaseRecord | null> {
  const cases = await readCases();
  return cases.find(c => c.id === id) ?? null;
}

// ── Update (label, status, note, expected) ──

export async function updateCase(
  id: string,
  update: {
    label?: CaseLabel;
    status?: CaseRecord["status"];
    note?: string;
    expected?: CaseRecord["expected"];
    rootCause?: CaseRecord["rootCause"];
  },
): Promise<CaseRecord | null> {
  const cases = await readCases();
  const idx = cases.findIndex(c => c.id === id);
  if (idx === -1) return null;

  const prevLabel = cases[idx].label;
  const labelChanged = update.label !== undefined && update.label !== prevLabel;

  if (update.label !== undefined) {
    cases[idx].label = update.label;
    // Auto-set status to "reviewed" when label is set, unless explicitly provided
    if (update.status === undefined) {
      cases[idx].status = "reviewed";
    }
  }
  if (update.status !== undefined) cases[idx].status = update.status;
  if (update.note !== undefined) cases[idx].note = update.note;
  if (update.expected !== undefined) cases[idx].expected = update.expected;
  if (update.rootCause !== undefined) cases[idx].rootCause = update.rootCause;

  await writeCases(cases);

  // ── Sync label change to raw data task (fire-and-forget) ──
  if (labelChanged && cases[idx].input.hasImage) {
    syncCaseLabelToVqa(id, update.label ?? null).catch((err) => {
      console.warn("[cases] raw data label sync failed:", err);
    });
  }

  return cases[idx];
}
