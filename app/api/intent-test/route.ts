import { NextResponse } from "next/server";
import { testIntent, getAllIntents } from "@/lib/beer-agent/intent-registry";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const intents = getAllIntents().map((d) => ({
    id: d.id,
    label: d.label,
    description: d.description,
    rules: d.rules.map((r) => ({
      pattern: r.pattern,
      requiresImage: r.requiresImage,
      confidence: r.confidence,
    })),
    handler: d.handler,
    supportsImage: d.supportsImage,
    requiresActiveMenu: false,
  }));
  return NextResponse.json({ intents });
}

export async function POST(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await request.json();
  const { text = "", hasImage = false, options } = body;

  if (!text.trim()) {
    return NextResponse.json(
      { error: "text is required" },
      { status: 400 },
    );
  }

  const result = testIntent(text, hasImage, options);
  return NextResponse.json(result);
}
