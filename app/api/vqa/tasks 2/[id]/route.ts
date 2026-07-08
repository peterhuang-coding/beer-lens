import { NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDebugRequestAllowed } from "@/lib/debug-auth";
import { validatePatchBody } from "@/lib/vqa-pipeline/pure";
import type { VqaTask } from "@/lib/vqa-pipeline/types";

export const runtime = "nodejs";

const TASKS_PATH = path.join(process.cwd(), "data", "vqa-tasks", "tasks.json");

async function readTasks(): Promise<VqaTask[]> {
  try {
    const raw = await readFile(TASKS_PATH, "utf8");
    const tasks = JSON.parse(raw);
    return Array.isArray(tasks) ? tasks : [];
  } catch {
    return [];
  }
}

async function writeTasks(tasks: VqaTask[]): Promise<void> {
  const dir = path.dirname(TASKS_PATH);
  await mkdir(dir, { recursive: true });
  await writeFile(TASKS_PATH, JSON.stringify(tasks, null, 2) + "\n");
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;

  // Parse body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Validate
  const validation = validatePatchBody(body);
  if (!validation.valid) {
    return NextResponse.json(
      { error: "validation_failed", details: validation.errors },
      { status: 400 },
    );
  }

  const { labels, status } = validation;

  // Read, find, update
  const tasks = await readTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) {
    return NextResponse.json({ error: "task_not_found" }, { status: 404 });
  }

  const task = tasks[idx];
  const now = new Date().toISOString();

  // Merge labels (don't clear existing ones not in the patch)
  if (Object.keys(labels).length > 0) {
    task.labels = { ...task.labels, ...labels };
  }

  if (status) {
    task.status = status;
  }

  task.updatedAt = now;
  tasks[idx] = task;

  await writeTasks(tasks);

  return NextResponse.json(task);
}
