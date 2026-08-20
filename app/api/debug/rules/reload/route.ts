/**
 * POST /api/debug/rules/reload — re-import lib/harness/rules.ts and reload
 * YAML rules from data/rules/*.yaml so any edits take effect without a
 * full process restart.
 *
 * Starter rules in lib/harness/rules.ts require Next.js HMR (dev) or a
 * process restart (prod); YAML rules in data/rules/*.yaml are re-loaded
 * eagerly here.
 */

import { NextResponse } from "next/server";
import { isDebugRequestAllowed } from "@/lib/debug-auth";
import { join } from "node:path";
import { mergeYmlRules, listRules } from "@/lib/harness/rules";
import { loadYamlHardRules } from "@/lib/harness/yaml-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const yamlRules = loadYamlHardRules(join(process.cwd(), "data", "rules"));
    const added = mergeYmlRules(yamlRules as never);
    const total = listRules().length;
    return NextResponse.json({ ok: true, rules_loaded: total, yaml_added: added });
  } catch (err) {
    return NextResponse.json({ error: "reload_failed", message: String((err as Error).message ?? err) }, { status: 500 });
  }
}
