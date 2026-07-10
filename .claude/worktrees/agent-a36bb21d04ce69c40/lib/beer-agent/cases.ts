/**
 * Case recording — every turn gets a case record for VQA analysis.
 * Labels are optional; unlabeled cases are just "recorded" for later review.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { TraceRecord } from "./dialog-types";

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
  };
  /** Review status */
  status: "unlabeled" | "reviewed" | "fixed" | "ignored";
  /** Warnings from guardrails */
  warnings: string[];
};

const CASES_PATH = path.join(process.cwd(), "data", "cases.json");

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
    replyPreview: trace.output.reply.slice(0, 300),
    candidateCount: trace.output.candidateCount,
    label: null,
    status: "unlabeled",
    warnings: trace.debug?.warnings ?? [],
  };

  const cases = await readCases();
  cases.unshift(record);

  // Keep max 500 cases
  if (cases.length > 500) cases.length = 500;

  await writeCases(cases);
  return record;
}

// ── List with filters ──

export async function listCases(filters?: {
  status?: string;
  label?: string;
}): Promise<CaseRecord[]> {
  let cases = await readCases();
  if (filters?.status) {
    cases = cases.filter(c => c.status === filters.status);
  }
  if (filters?.label) {
    cases = cases.filter(c => c.label === filters.label);
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
  update: { label?: CaseLabel; status?: CaseRecord["status"]; note?: string; expected?: CaseRecord["expected"] },
): Promise<CaseRecord | null> {
  const cases = await readCases();
  const idx = cases.findIndex(c => c.id === id);
  if (idx === -1) return null;

  if (update.label !== undefined) cases[idx].label = update.label;
  if (update.status !== undefined) cases[idx].status = update.status;
  if (update.note !== undefined) cases[idx].note = update.note;
  if (update.expected !== undefined) cases[idx].expected = update.expected;

  await writeCases(cases);
  return cases[idx];
}
