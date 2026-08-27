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

  // 4. 大牌哨兵 — 世界知名啤酒必须能查到,漏了直接报警
  //    (2026-08-28 起:Beck's 曾因撇号归一缺失+50k 爬取缺口双重问题查不到)
  let sentinels: unknown = { error: "哨兵不可用" };
  let cnSentinels: unknown = { error: "中国精酿哨兵不可用" };
  try {
    const { lookupBeers } = await import("@/lib/beer-agent/beer-db");
    const SENTINEL_BEERS = [
      "Becks", "Guinness", "Heineken", "Tsingtao", "Corona", "Budweiser",
      "Stella Artois", "Hoegaarden", "Duvel", "Carlsberg", "Pilsner Urquell",
    ];
    const rs = await lookupBeers(SENTINEL_BEERS);
    sentinels = SENTINEL_BEERS.map((q, i) => {
      const r = rs[i];
      return r?.found && r.data
        ? { query: q, found: true, name: r.data.name }
        : { query: q, found: false };
    });
    // 中国精酿验收组:当前全红属预期(China=0),P3 补爬后应转绿
    const CN_SENTINELS = ["Jing-A", "Master Gao", "Slow Boat", "NBeer", "Trueman"];
    const cnRs = await lookupBeers(CN_SENTINELS);
    cnSentinels = CN_SENTINELS.map((q, i) => {
      const r = cnRs[i];
      return r?.found && r.data
        ? { query: q, found: true, name: r.data.name }
        : { query: q, found: false };
    });
  } catch (err: any) {
    sentinels = { error: String(err?.message ?? err) };
  }

  const report = {
    generated_at: new Date().toISOString(),
    data_quality: dataQuality,
    routing,
    sentinels,
    cn_sentinels: cnSentinels,
    health: {
      rpm: health.rpm,
      p50_ms: health.p50_latency_ms,
      p95_ms: health.p95_latency_ms,
      error_rate: health.error_rate,
      skill_distribution: health.skill_distribution.slice(0, 8),
      rule_hits: health.rule_hits.filter((r) => r.count > 0).slice(0, 8),
    },
  };

  // 测评历史存档(趋势对比用,fire-and-forget,失败不影响响应)
  import("node:fs/promises")
    .then(({ appendFile }) =>
      appendFile(
        path.join(process.cwd(), "data", "selfcheck-history.jsonl"),
        JSON.stringify({
          ts: report.generated_at,
          routing_pct: (report.routing as any)?.accuracy_pct ?? null,
          sentinels_ok: Array.isArray(report.sentinels)
            ? report.sentinels.filter((s: any) => s.found).length
            : null,
          cn_ok: Array.isArray(report.cn_sentinels)
            ? report.cn_sentinels.filter((s: any) => s.found).length
            : null,
          error_rate: (report.health as any)?.error_rate ?? null,
        }) + "\n",
      )
      .catch(() => {}),
    );

  return NextResponse.json(report);
}
