import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDebugRequestAllowed } from "@/lib/debug-auth";
import type { VqaTask, VqaStatus } from "@/lib/vqa-pipeline/types";

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

export async function GET(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") as VqaStatus | null;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50") || 50, 200);

  let tasks = await readTasks();

  if (status) {
    tasks = tasks.filter((t) => t.status === status);
  }

  tasks = tasks.slice(0, limit);

  return NextResponse.json(tasks);
}
