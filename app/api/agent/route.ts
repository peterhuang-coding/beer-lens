import { NextResponse } from "next/server";
import { runBeerAgent } from "@/lib/beer-agent/provider";
import type { AgentRequest } from "@/lib/beer-agent/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as AgentRequest;
    const result = await runBeerAgent(body);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown beer agent error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

