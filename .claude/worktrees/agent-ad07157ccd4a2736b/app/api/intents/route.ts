import { NextResponse } from "next/server";
import { registerIntent, unregisterIntent, getAllIntents, getIntent } from "@/lib/beer-agent/intent-registry";
import type { IntentDefinition } from "@/lib/beer-agent/intent-registry";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const intents = getAllIntents().map(d => ({
    id: d.id,
    label: d.label,
    description: d.description,
    priority: d.priority,
    handler: d.handler,
    supportsImage: d.supportsImage,
    rulesCount: d.rules.length,
    samplesCount: d.samples?.length ?? 0,
    enabled: d.enabled !== false,
  }));
  return NextResponse.json(intents);
}

export async function POST(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const def: IntentDefinition = {
      id: body.id?.trim() || "",
      label: body.label?.trim() || body.id || "",
      description: body.description?.trim() || "",
      priority: body.priority ?? 99,
      rules: body.rules ?? [],
      samples: body.samples ?? [],
      handler: body.handler ?? "handleCustom",
      supportsImage: body.supportsImage ?? false,
      enabled: body.enabled !== false,
      updatedAt: new Date().toISOString(),
    };

    if (!def.id) {
      return NextResponse.json({ error: "intent id is required" }, { status: 400 });
    }

    // Don't allow overwriting built-in intents via API
    const builtinIds = new Set([
      "menu_recommend", "tasting_feedback", "profile_query",
      "beer_knowledge", "label_check", "memory_correction", "unclear",
    ]);
    if (builtinIds.has(def.id)) {
      return NextResponse.json({ error: "cannot modify built-in intent" }, { status: 403 });
    }

    registerIntent(def);
    return NextResponse.json({ ok: true, intent: def });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const ok = unregisterIntent(id);
  if (!ok) {
    return NextResponse.json({ error: "intent not found or is built-in" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
