import { NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

const TASKS_PATH = path.join(process.cwd(), "data", "vqa-tasks", "tasks.json");

interface VqaTask {
  id: string;
  imageUrl: string;
  title?: string;
  candidateBeerName?: string;
  description?: string;
  questions: Array<{ id: string; type: string; prompt: string; options?: string[] }>;
  labels: Record<string, unknown>;
  status: string;
  createdAt: string;
  updatedAt: string;
}

async function readTasks(): Promise<VqaTask[]> {
  try {
    const raw = await readFile(TASKS_PATH, "utf8");
    const tasks = JSON.parse(raw);
    return Array.isArray(tasks) ? tasks : [];
  } catch {
    return [];
  }
}

async function writeTasks(tasks: VqaTask[]) {
  await writeFile(TASKS_PATH, JSON.stringify(tasks, null, 2) + "\n", "utf8");
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = (await request.json()) as Partial<VqaTask>;

  const tasks = await readTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Merge labels (partial update)
  if (body.labels) {
    tasks[idx].labels = { ...tasks[idx].labels, ...body.labels };
  }

  // Overwrite other fields
  if (body.status) tasks[idx].status = body.status;
  tasks[idx].updatedAt = new Date().toISOString();

  await writeTasks(tasks);

  return NextResponse.json(tasks[idx]);
}