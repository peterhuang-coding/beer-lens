/**
 * GET /api/debug/env — expose the LLM/OPENROUTER/DEBUG env knobs read by
 * the running chat pipeline. Server-side masks any value containing KEY,
 * SECRET, or TOKEN to its last 4 characters so the secret itself never
 * leaves the server. The full list is restricted to the keys the harness
 * actually reads — nothing else from process.env is exposed.
 */

import { NextResponse } from "next/server";
import { isDebugRequestAllowed } from "@/lib/debug-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPOSED_KEYS = [
  "LLM_PROVIDER",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_TEMPERATURE",
  "LLM_MAX_TOKENS",
  "LLM_COMPOSE_REPLY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_VISION_MODEL",
  "OPENROUTER_ANALYSIS_MODEL",
  "DEBUG_API_TOKEN",
] as const;

const SENSITIVE_SUFFIXES = ["KEY", "SECRET", "TOKEN"];

function isSensitive(key: string): boolean {
  const upper = key.toUpperCase();
  return SENSITIVE_SUFFIXES.some((s) => upper.includes(s));
}

function maskValue(value: string): string {
  if (value.length <= 4) return "****";
  return `…${value.slice(-4)}`;
}

export async function GET(request: Request): Promise<Response> {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const env: Record<string, string | null> = {};
  for (const k of EXPOSED_KEYS) {
    const raw = process.env[k];
    if (raw === undefined) {
      env[k] = null;
    } else if (isSensitive(k)) {
      env[k] = maskValue(raw);
    } else {
      env[k] = raw;
    }
  }
  return NextResponse.json({ env });
}