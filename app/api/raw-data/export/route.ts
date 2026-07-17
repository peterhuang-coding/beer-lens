import { NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDebugRequestAllowed } from "@/lib/debug-auth";
import {
  filterLabeledTasks,
  labeledTaskToRegressionCase,
} from "@/lib/raw-pipeline/pure";
import type { RawTask } from "@/lib/raw-pipeline/types";

export const runtime = "nodejs";

const TASKS_PATH = path.join(process.cwd(), "data", "raw-data", "tasks.json");
const JSONL_PATH = path.join(process.cwd(), "data", "raw-dataset", "labeled.jsonl");
const REGRESSION_PATH = path.join(
  process.cwd(),
  "data",
  "regression-cases.raw-generated.json",
);

async function readTasks(): Promise<RawTask[]> {
  try {
    const raw = await readFile(TASKS_PATH, "utf8");
    const tasks = JSON.parse(raw);
    return Array.isArray(tasks) ? tasks : [];
  } catch {
    return [];
  }
}

async function writeTasks(tasks: RawTask[]): Promise<void> {
  const dir = path.dirname(TASKS_PATH);
  await mkdir(dir, { recursive: true });
  await writeFile(TASKS_PATH, JSON.stringify(tasks, null, 2) + "\n");
}

export async function POST(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Optional: accept body with flags
  let generateRegressionCases = false;
  try {
    const body = await request.json();
    generateRegressionCases = !!body.regressionCases;
  } catch {
    // No body — default behavior
  }

  const tasks = await readTasks();
  const labeled = filterLabeledTasks(tasks);

  if (labeled.length === 0) {
    return NextResponse.json(
      { error: "no_labeled_tasks", message: "No labeled tasks to export." },
      { status: 400 },
    );
  }

  // Write JSONL
  const jsonlDir = path.dirname(JSONL_PATH);
  await mkdir(jsonlDir, { recursive: true });

  const jsonlContent =
    labeled.map((t) => JSON.stringify(t)).join("\n") + "\n";
  await writeFile(JSONL_PATH, jsonlContent);

  // Optionally write regression cases
  if (generateRegressionCases) {
    const regressionCases = labeled
      .map(labeledTaskToRegressionCase)
      .filter((c): c is Record<string, unknown> => c !== null);

    const regDir = path.dirname(REGRESSION_PATH);
    await mkdir(regDir, { recursive: true });
    await writeFile(
      REGRESSION_PATH,
      JSON.stringify(regressionCases, null, 2) + "\n",
    );
  }

  // Mark as exported
  for (const t of tasks) {
    if (t.status === "labeled") {
      t.status = "exported";
      t.updatedAt = new Date().toISOString();
    }
  }
  await writeTasks(tasks);

  return NextResponse.json({
    ok: true,
    exported: labeled.length,
    jsonlPath: "data/raw-dataset/labeled.jsonl",
    regressionCasesPath: generateRegressionCases
      ? "data/regression-cases.raw-generated.json"
      : undefined,
  });
}