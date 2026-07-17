import { NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

const TASKS_PATH = path.join(process.cwd(), "data", "raw-data", "query-tasks.json");

async function readTasks(): Promise<any[]> {
  try {
    const raw = await readFile(TASKS_PATH, "utf8");
    const tasks = JSON.parse(raw);
    return Array.isArray(tasks) ? tasks : [];
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50") || 50, 200);

  let tasks = await readTasks();
  if (status) {
    tasks = tasks.filter((t) => t.status === status);
  }
  tasks = tasks.slice(0, limit);
  return NextResponse.json(tasks);
}

export async function PATCH(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const { id, labels, status } = await request.json();
    if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

    const tasks = await readTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return NextResponse.json({ error: "not found" }, { status: 404 });

    if (labels) tasks[idx].labels = labels;
    if (status) tasks[idx].status = status;
    tasks[idx].updatedAt = new Date().toISOString();

    await writeFile(TASKS_PATH, JSON.stringify(tasks, null, 2) + "\n", "utf8");
    return NextResponse.json(tasks[idx]);
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}