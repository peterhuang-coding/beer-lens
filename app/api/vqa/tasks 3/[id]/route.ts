import { NextResponse } from "next/server";
import { readFile, writeFile, mkdir } from "node:fs/promises";
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
  labels: Record<string, unknown>;
  status: string;
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

async function writeTasks(tasks: VqaTask[]): Promise<void> {
  await mkdir(path.dirname(TASKS_PATH), { recursive: true });
  await writeFile(TASKS_PATH, JSON.stringify(tasks, null, 2) + "\n", "utf8");
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const tasks = await readTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(task);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const tasks = await readTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (body.labels && typeof body.labels === "object") {
    tasks[idx].labels = { ...tasks[idx].labels, ...(body.labels as Record<string, unknown>) };
  }
  if (typeof body.status === "string") {
    tasks[idx].status = body.status;
  }
  tasks[idx].updatedAt = new Date().toISOString();

  await writeTasks(tasks);

  return NextResponse.json(tasks[idx]);
}