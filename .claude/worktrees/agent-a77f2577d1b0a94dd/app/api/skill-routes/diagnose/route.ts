import { NextResponse } from "next/server";
import { diagnoseRoute } from "@/lib/beer-agent/route-registry";
import type { RouteContextSnapshot } from "@/lib/beer-agent/route-registry";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { intent, context } = body as {
      intent: string;
      context: RouteContextSnapshot;
    };

    if (!intent || !context) {
      return NextResponse.json(
        { error: "缺少 intent 或 context" },
        { status: 400 },
      );
    }

    const diagnosis = diagnoseRoute(intent, context);
    return NextResponse.json(diagnosis);
  } catch (err) {
    return NextResponse.json(
      { error: `诊断失败: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
