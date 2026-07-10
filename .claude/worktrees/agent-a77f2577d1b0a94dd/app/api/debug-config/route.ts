import { NextResponse } from "next/server";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

const CONFIG_PATH = path.join(process.cwd(), "data", "pipeline-config.json");

async function readConfig(): Promise<Record<string, any>> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { config: {} };
  }
}

export async function GET(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);

  // Validation endpoint: check pipeline-config.json integrity
  if (searchParams.get("validate") === "true") {
    return validateConfig();
  }

  const data = await readConfig();
  return NextResponse.json(data);
}

/** Validate pipeline-config.json and return integrity report */
async function validateConfig(): Promise<NextResponse> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);

    const issues: string[] = [];
    const info: Record<string, unknown> = {};

    // Check top-level structure
    if (!parsed.config || typeof parsed.config !== "object") {
      issues.push("缺少 config 字段或类型错误");
    }

    if (parsed.models && typeof parsed.models === "object") {
      const requiredModels = ["vision", "analysis", "chat", "intent", "embedding"];
      for (const key of requiredModels) {
        const m = parsed.models[key];
        if (!m) {
          issues.push(`models.${key}: 缺失`);
        } else if (typeof m === "object" && !m.model) {
          issues.push(`models.${key}: 缺少 model 字段`);
        } else if (typeof m === "string" && !m) {
          issues.push(`models.${key}: 空字符串`);
        }
      }
    } else {
      issues.push("models 字段缺失或类型错误");
    }

    // Check prompts
    if (parsed.prompts && typeof parsed.prompts === "object") {
      const requiredPrompts = ["vision_ocr", "intent_classify", "beer_knowledge", "recommendation_reply", "guardrail", "memory_extract"];
      for (const id of requiredPrompts) {
        if (!parsed.prompts[id]) {
          issues.push(`prompts.${id}: 缺失`);
        }
      }
    } else {
      issues.push("prompts 字段缺失");
    }

    // Check tools
    if (parsed.tools && typeof parsed.tools === "object") {
      const toolIds = Object.keys(parsed.tools);
      for (const id of toolIds) {
        const t = parsed.tools[id];
        if (typeof t.enabled !== "boolean") {
          issues.push(`tools.${id}: enabled 字段不是 boolean`);
        }
        if (typeof t.timeoutMs !== "number") {
          issues.push(`tools.${id}: timeoutMs 字段不是 number`);
        }
      }
    }

    // Check intentEngine
    if (parsed.intentEngine) {
      const ie = parsed.intentEngine;
      if (!Array.isArray(ie.steps)) {
        issues.push("intentEngine.steps 不是数组");
      }
      if (typeof ie.recallThreshold !== "number") issues.push("intentEngine.recallThreshold 不是 number");
      if (typeof ie.matchThreshold !== "number") issues.push("intentEngine.matchThreshold 不是 number");

      const enabledSteps = (ie.steps || []).filter((s: any) => s.enabled);
      info.enabledSteps = enabledSteps.map((s: any) => s.id);
    }

    // Check routes
    if (Array.isArray(parsed.routes)) {
      const routeIntents = new Set<string>();
      for (const route of parsed.routes) {
        if (routeIntents.has(route.intent)) {
          issues.push(`routes: 重复的 intent "${route.intent}"`);
        }
        routeIntents.add(route.intent);
        if (!route.handler) issues.push(`routes.${route.intent}: 缺少 handler`);
        if (typeof route.enabled !== "boolean") issues.push(`routes.${route.intent}: 缺少 enabled 字段`);
      }
      info.routeCount = parsed.routes.length;
    } else {
      issues.push("routes 缺失或不是数组");
    }

    return NextResponse.json({
      ok: issues.length === 0,
      issues: issues.length > 0 ? issues : undefined,
      info,
      lastParsedAt: new Date().toISOString(),
      jsonlSize: raw.length,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      issues: [`JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`],
      lastParsedAt: new Date().toISOString(),
    });
  }
}

export async function PUT(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const body = await request.json();
    const current = await readConfig();
    const next = {
      ...current,
      ...body,
      config: {
        ...(current.config || {}),
        ...(body.config || {}),
      },
    };
    await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
