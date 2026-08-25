import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readFileSync } from "node:fs";
import { isDebugRequestAllowed } from "@/lib/debug-auth";
import { getStats } from "@/lib/harness/stats";

export const runtime = "nodejs";
const execFileAsync = promisify(execFile);

/**
 * 一键测评 — 聚合三类自检,全部无 LLM 成本(图片 QA 除外):
 *   1. 数据体检  python3 .beer-data/lookup.py --audit
 *   2. 路由自测  regression-cases.json × keywordRoute(规则层)
 *   3. 链路健康  lib/harness/stats 最近 5 分钟窗口
 */
export async function GET(request: Request) {
  if (!isDebugRequestAllowed(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 1. 数据体检
  let dataQuality: unknown = { error: "lookup.py --audit 不可用" };
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [path.join(process.cwd(), ".beer-data", "lookup.py"), "--audit"],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    dataQuality = JSON.parse(stdout.trim());
  } catch (err: any) {
    dataQuality = { error: String(err?.message ?? err) };
  }

  // 2. 路由自测(规则层,零 LLM 调用)
  let routing: unknown = { error: "回归用例不可用" };
  try {
    // 延迟导入,保证 harness skill 注册副作用先执行
    const { keywordRoute } = await import("@/lib/harness/router-rules");
    await import("@/lib/harness/skill-registry");
    const cases = JSON.parse(
      readFileSync(path.join(process.cwd(), "data", "regression-cases.json"), "utf8"),
    ) as Array<{ id?: string; inputText?: string; expectedIntent?: string; multiTurn?: boolean }>;
    let pass = 0;
    let wrong = 0;
    let noRoute = 0;
    const worst: Record<string, number> = {};
    for (const c of cases) {
      const d = keywordRoute(String(c.inputText ?? ""), true) as { skill_id?: string } | null;
      const exp =
        c.expectedIntent === "follow_up_filter" && !c.multiTurn
          ? "menu_recommend"
          : c.expectedIntent;
      const act = d?.skill_id ?? null;
      if (act === exp) {
        pass++;
      } else {
        wrong++;
        if (!act) {
          noRoute++;
        } else {
          const k = `${exp}→${act}`;
          worst[k] = (worst[k] ?? 0) + 1;
        }
      }
    }
    routing = {
      total: cases.length,
      pass,
      wrong,
      no_rule_route: noRoute,
      accuracy_pct: +(pass / cases.length * 100).toFixed(1),
      top_mismatches: Object.entries(worst)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, n]) => ({ pattern: k, count: n })),
    };
  } catch (err: any) {
    routing = { error: String(err?.message ?? err) };
  }

  // 3. 链路健康(最近 5 分钟 trace 窗口)
  const health = getStats();

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    data_quality: dataQuality,
    routing,
    health: {
      rpm: health.rpm,
      p50_ms: health.p50_latency_ms,
      p95_ms: health.p95_latency_ms,
      error_rate: health.error_rate,
      skill_distribution: health.skill_distribution.slice(0, 8),
      rule_hits: health.rule_hits.filter((r) => r.count > 0).slice(0, 8),
    },
  });
}
