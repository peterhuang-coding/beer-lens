"use client";

import { useState, useEffect, useCallback, type CSSProperties, type ReactNode } from "react";

// ── Pipeline definition ──

type PipeNode = {
  id: string;
  label: string;
  layer: "entry" | "intent" | "dispatch" | "route" | "handler" | "memory" | "data" | "postprocess" | "monitor" | "output";
  description: string;
  file: string;
  configurable?: { key: string; label: string; value: string | number | boolean; type: "text" | "number" | "boolean" | "select"; options?: string[] }[];
  hasOverrides?: boolean;
  status?: "ok" | "warn" | "error";
};

const layers: { id: PipeNode["layer"]; label: string; color: string }[] = [
  { id: "entry", label: "入口", color: "#6c5ce7" },
  { id: "intent", label: "意图", color: "#00b894" },
  { id: "dispatch", label: "调度", color: "#fdcb6e" },
  { id: "route", label: "路由分发", color: "#a29bfe" },
  { id: "handler", label: "Handler", color: "#e17055" },
  { id: "memory", label: "记忆", color: "#0984e3" },
  { id: "data", label: "数据", color: "#00cec9" },
  { id: "postprocess", label: "后置", color: "#6c5ce7" },
  { id: "monitor", label: "监控", color: "#ff6b6b" },
  { id: "output", label: "输出", color: "#636e72" },
];

const pipelineNodes: PipeNode[] = [
  {
    id: "orchestrator", label: "Orchestrator\n统一入口", layer: "entry",
    description: "所有渠道(Web/Feishu/CLI)的统一入口。生成 traceId，构建 IntentContext，调用意图识别，分发到 handler，最后过 guardrail 写 trace。",
    file: "lib/beer-agent/orchestrator.ts",
    configurable: [
      { key: "traceEnabled", label: "Trace 落盘", value: true, type: "boolean" },
      { key: "memoryEnabled", label: "短期记忆", value: true, type: "boolean" },
    ],
  },
  {
    id: "intent-classifier", label: "Intent Engine\n意图识别引擎", layer: "intent",
    description: "总能力层 — 规则优先 + 样本匹配 + LLM fallback。多意图（Multi-Intent）是引擎的输出模式之一，不是独立引擎。主意图路由到 Handler，副意图作为上下文传给分发层。",
    file: "lib/beer-agent/intent-classifier.ts",
    configurable: [
      { key: "ruleConfidenceThreshold", label: "规则置信度阈值", value: 0.7, type: "number" },
      { key: "multiIntentGap", label: "多意图间隔阈值", value: 0.15, type: "number" },
      { key: "llmFallbackModel", label: "LLM Fallback 模型", value: "openai/gpt-4o-mini", type: "select", options: ["openai/gpt-4o-mini", "google/gemini-2.5-flash", "anthropic/claude-haiku"] },
    ],
    hasOverrides: true,
  },
  {
    id: "dispatcher", label: "Dispatcher\n意图分发", layer: "dispatch",
    description: "根据 intentResult.intent 路由到对应 handler。8 个 handler 各司其职。handler 抛错时返回兜底回复。",
    file: "lib/beer-agent/dispatcher.ts",
    configurable: [
      { key: "fallbackReply", label: "兜底回复", value: "抱歉，处理你的请求时出错了。请再试一次。", type: "text" },
    ],
  },
  {
    id: "route-event", label: "Route 事件\n分发仲裁", layer: "route",
    description: "Dispatcher 将 IntentResult 转为路由事件，仲裁哪个 handler 响应。单意图直发 handler，多意图走 Planner 或并行通知。",
    file: "lib/beer-agent/dispatcher.ts",
  },
  {
    id: "handler-menu", label: "Menu Recommend\n酒单推荐", layer: "handler",
    description: "图片模式走 Image Pipeline (视觉分类+OCR+质量检查)；文本模式走 LLM。调用 beer-db 查真实评分，用推荐模块打分选 pick。",
    file: "lib/beer-agent/handlers/menu-recommend.ts",
    configurable: [
      { key: "enrichFromDb", label: "从 Beer DB 查评分", value: true, type: "boolean" },
    ],
  },
  {
    id: "handler-followup", label: "Follow-up Filter\n追问过滤", layer: "handler",
    description: "基于 short-term memory 中上一轮酒单候选做过滤/重排。无上下文时提示用户先发酒单。",
    file: "lib/beer-agent/handlers/follow-up-filter.ts",
  },
  {
    id: "handler-feedback", label: "Tasting Feedback\n品饮反馈", layer: "handler",
    description: "解析用户文本中的评分(1-5分)、是否再喝、风味标签。匹配 short-term memory 中的活跃啤酒，写入 episodic memory 并重建 taste profile。",
    file: "lib/beer-agent/handlers/tasting-feedback.ts",
    configurable: [
      { key: "autoMatchBeer", label: "自动匹配啤酒", value: true, type: "boolean" },
    ],
  },
  {
    id: "handler-profile", label: "Profile Query\n画像查询", layer: "handler",
    description: "读取 ProfileMemory (偏好风格/标签/ABV 区间)，返回结构化口味画像总结。",
    file: "lib/beer-agent/handlers/profile-query.ts",
  },
  {
    id: "handler-knowledge", label: "Beer Knowledge\n啤酒知识", layer: "handler",
    description: "纯 LLM 回答。不查数据库，不编造酒名。",
    file: "lib/beer-agent/handlers/beer-knowledge.ts",
    configurable: [
      { key: "model", label: "LLM 模型", value: "openai/gpt-4o-mini", type: "select", options: ["openai/gpt-4o-mini", "google/gemini-2.5-flash", "anthropic/claude-haiku"] },
    ],
  },
  {
    id: "handler-label", label: "Label Check\n酒标检查", layer: "handler",
    description: "复用 Image Pipeline。提取单瓶/单罐的酒名、日期、视觉质量风险。",
    file: "lib/beer-agent/handlers/label-check.ts",
  },
  {
    id: "handler-correction", label: "Memory Correction\n记忆纠正", layer: "handler",
    description: "处理用户纠正/重置（清空、清除、重置）。引导用户重置上下文。",
    file: "lib/beer-agent/handlers/memory-correction.ts",
  },
  {
    id: "handler-unclear", label: "Unclear\n意图不明", layer: "handler",
    description: "根据是否有图片发不同追问：'想让我看酒单推荐，还是检查这瓶酒？' / '想推荐啤酒、记录喝过的酒，还是了解啤酒知识？'",
    file: "lib/beer-agent/handlers/unclear.ts",
  },
  {
    id: "memory-system", label: "Memory System\n记忆系统", layer: "memory",
    description: "统一记忆层：短期记忆（酒单候选/picks/对话轮）、品饮记录、口味画像、长期趋势、画像标签猜问。tasting_feedback 触发后自动重建。",
    file: "lib/beer-agent/memory/",
  },
  {
    id: "beer-db", label: "Beer DB Pipeline\n啤酒数据库", layer: "data",
    description: "统一数据入口。SQLite 14,242 款 + Untappd 缓存。Node.js → Python lookup.py。pipeline.ts 封装 lookup + enrich + cache + stats，对外唯一接口。后续扩展：定时更新、增量写入、热加载、多数据源。",
    file: "lib/beer-agent/beer-db/pipeline.ts",
    configurable: [
      { key: "searchLimit", label: "搜索结果上限", value: 5, type: "number" },
      { key: "cacheTtlDays", label: "缓存有效期(天)", value: 365, type: "number" },
    ],
  },
  {
    id: "recommendation", label: "Recommendation\n推荐引擎", layer: "data",
    description: "Scoring(worthScore+fitScore) → Pick Selector(top/safe/explore/avoid) → Reply Builder(中文推荐语)。fitScore 会根据用户画像和约束词调整。",
    file: "lib/beer-agent/recommendation/",
  },
  {
    id: "guardrails", label: "Guardrails\n后置规则", layer: "postprocess",
    description: "5 条规则：候选酒名检查、评分来源验证、低置信度标记、高 ABV 提醒、数据缺失检查。超过 10 条 warning 时拦截回复。",
    file: "lib/beer-agent/postprocess/guardrails.ts",
    configurable: [
      { key: "maxWarnings", label: "拦截阈值(warnings)", value: 10, type: "number" },
    ],
  },
  {
    id: "trace", label: "Trace Writer\n追踪落盘", layer: "output",
    description: "每轮对话写入 data/traces/YYYY-MM-DD/trace_xxx.json。包含 input/intent/route/output/errors。",
    file: "lib/beer-agent/trace.ts",
    configurable: [
      { key: "enabled", label: "启用", value: true, type: "boolean" },
    ],
  },
  {
    id: "monitor", label: "Metrics Monitor\n旁路监控", layer: "monitor",
    description: "旁路收集运营指标：响应时延、意图命中率(rule/llm/fallback)、多意图率、知识库命中率、护栏拦截率、转人工率。每30秒写入 data/metrics/。",
    file: "lib/beer-agent/monitor/metrics.ts",
    configurable: [
      { key: "flushIntervalMs", label: "落盘间隔(ms)", value: 30000, type: "number" },
      { key: "transferThreshold", label: "转人工阈值(unclear次数)", value: 3, type: "number" },
    ],
  },
  {
    id: "long-term-memory", label: "Long-Term Memory\n长期记忆", layer: "memory",
    description: "从所有品饮记录聚合长期趋势：常喝酒厂/国家、ABV 偏好演化、风味词云、待评分啤酒列表。品饮反馈后自动重建。",
    file: "lib/beer-agent/memory/long-term.ts",
    configurable: [
      { key: "rebuildOnFeedback", label: "反馈时自动重建", value: true, type: "boolean" },
    ],
  },
  {
    id: "profile-tags", label: "Profile Tag Guess\n画像标签猜问", layer: "memory",
    description: "基于用户画像生成主动猜问。策略：偏好风格×相邻风格推荐、风味标签×未试风格、未评分酒款提醒。在推荐回复末尾注入猜问。",
    file: "lib/beer-agent/memory/profile-tag-guess.ts",
    configurable: [
      { key: "guessConfidenceThreshold", label: "猜问置信度阈值", value: 0.6, type: "number" },
    ],
  },
];

// ── Flow connections ──
const connections: [string, string][] = [
  ["orchestrator", "intent-classifier"],
  ["intent-classifier", "dispatcher"],
  ["dispatcher", "route-event"],
  ["route-event", "handler-menu"],
  ["route-event", "handler-followup"],
  ["route-event", "handler-feedback"],
  ["route-event", "handler-profile"],
  ["route-event", "handler-knowledge"],
  ["route-event", "handler-label"],
  ["route-event", "handler-correction"],
  ["route-event", "handler-unclear"],
  ["handler-menu", "beer-db"],
  ["handler-menu", "recommendation"],
  ["handler-label", "beer-db"],
  ["handler-followup", "memory-system"],
  ["handler-feedback", "memory-system"],
  ["handler-feedback", "long-term-memory"],
  ["handler-profile", "memory-system"],
  ["long-term-memory", "profile-tags"],
  ["profile-tags", "orchestrator"],
  ["handler-menu", "guardrails"],
  ["handler-followup", "guardrails"],
  ["handler-feedback", "guardrails"],
  ["handler-knowledge", "guardrails"],
  ["handler-label", "guardrails"],
  ["orchestrator", "trace"],
  ["orchestrator", "monitor"],
  ["monitor", "trace"],
  ["memory-system", "orchestrator"],
];

// ── Color map ──
const layerColor = Object.fromEntries(layers.map(l => [l.id, l.color]));

export default function PipelinePage() {
  const [selectedNode, setSelectedNode] = useState<PipeNode | null>(null);
  const [editing, setEditing] = useState<Record<string, Record<string, any>>>({});
  const [intentOverrides, setIntentOverrides] = useState<Array<{ regex: string; intent: string; note?: string }>>([]);
  const [view, setView] = useState<"pipeline" | "cases" | "intent-test" | "intent-config" | "skill-routes" | "diagnosis" | "metrics" | "planner" | "memory-trace" | "raw-data" | "benchmark" | "prompt-models">("pipeline");

  // ── Two-level navigation groups ──
  type NavGroup = { id: string; label: string; views: typeof view[]; color: string };
  const navGroups: NavGroup[] = [
    { id: "architecture",  label: "架构", views: ["pipeline", "skill-routes", "planner"],    color: "#6c5ce7" },
    { id: "intent",        label: "意图", views: ["intent-test", "intent-config"],            color: "#00b894" },
    { id: "annotation",    label: "标注", views: ["cases", "raw-data"],                             color: "#e17055" },
    { id: "monitoring",    label: "监控", views: ["metrics", "diagnosis", "memory-trace", "benchmark"], color: "#0984e3" },
    { id: "config",        label: "配置", views: ["prompt-models"],                            color: "#636e72" },
  ];

  // Derive active group from current view
  const activeGroup = navGroups.find(g => g.views.includes(view)) ?? navGroups[0];

  // Load saved config
  useEffect(() => {
    fetch("/api/debug-config")
      .then(r => r.json().catch(() => ({})))
      .then(d => {
        setEditing(d.config || {});
        setIntentOverrides(d.intentOverrides || []);
      })
      .catch(() => {});
  }, []);

  const updateConfig = (nodeId: string, key: string, val: any) => {
    const next = { ...editing, [nodeId]: { ...(editing[nodeId] || {}), [key]: val } };
    setEditing(next);
    saveAll(next, intentOverrides);
  };

  const saveAll = (config: any, overrides: any[]) => {
    fetch("/api/debug-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config, intentOverrides: overrides }) });
  };

  const addOverride = () => {
    const next = [...intentOverrides, { regex: "", intent: "unclear", note: "" }];
    setIntentOverrides(next);
    saveAll(editing, next);
  };

  const updateOverride = (idx: number, field: string, val: string) => {
    const next = intentOverrides.map((o, i) => i === idx ? { ...o, [field]: val } : o);
    setIntentOverrides(next);
    saveAll(editing, next);
  };

  const deleteOverride = (idx: number) => {
    const next = intentOverrides.filter((_, i) => i !== idx);
    setIntentOverrides(next);
    saveAll(editing, next);
  };

  const getNodeConfig = (node: PipeNode) => {
    const saved = editing[node.id] || {};
    return (node.configurable || []).map(c => ({ ...c, value: saved[c.key] ?? c.value }));
  };

  // ── Layout engine: hand-crafted positions (no crossing lines) ──
  // The pipeline is arranged in 5 horizontal lanes:
  //   Lane 1 (top):   orchestrator → intent → dispatcher → route → handlers → guardrails → trace
  //   Lane 2 (mid):   Memory System (consolidated)
  //   Lane 3:         Long-term memory, profile tags
  //   Lane 4 (bot):   data modules (beerDb, recommendation)
  //   Lane 5:         monitor (side channel)

  const NODE_W = 150, NODE_H = 56;
  const nodePositions: Record<string, { x: number; y: number }> = {};

  // ── Main pipeline lane (y=40) ──
  const MAIN_Y = 40;
  // entry
  nodePositions["orchestrator"]      = { x: 30,  y: MAIN_Y };
  // intent
  nodePositions["intent-classifier"] = { x: 210, y: MAIN_Y };
  // dispatch
  nodePositions["dispatcher"]        = { x: 370, y: MAIN_Y };
  // route
  nodePositions["route-event"]       = { x: 510, y: MAIN_Y };
  // handlers (two columns, each 4 rows)
  nodePositions["handler-menu"]       = { x: 690, y: 20 };
  nodePositions["handler-followup"]   = { x: 690, y: 82 };
  nodePositions["handler-feedback"]   = { x: 690, y: 144 };
  nodePositions["handler-profile"]    = { x: 690, y: 206 };
  nodePositions["handler-knowledge"]  = { x: 860, y: 20 };
  nodePositions["handler-label"]      = { x: 860, y: 82 };
  nodePositions["handler-correction"] = { x: 860, y: 144 };
  nodePositions["handler-unclear"]    = { x: 860, y: 206 };
  // postprocess
  nodePositions["guardrails"]        = { x: 1030, y: MAIN_Y + 60 };
  // output
  nodePositions["trace"]             = { x: 1210, y: MAIN_Y };

  // ── Memory lane (y=300) ── consolidated node
  const MEM_Y = 300;
  nodePositions["memory-system"]     = { x: 510, y: MEM_Y };

  // ── Long-term memory + profile tags lane (y=380) ──
  const LTM_Y = 380;
  nodePositions["long-term-memory"]  = { x: 690, y: LTM_Y };
  nodePositions["profile-tags"]      = { x: 870, y: LTM_Y };

  // ── Data lane (y=460) ──
  nodePositions["beer-db"]           = { x: 690, y: 460 };
  nodePositions["recommendation"]    = { x: 870, y: 460 };

  // ── Monitor lane (y=540) ──
  nodePositions["monitor"]           = { x: 1210, y: 540 };

  const maxX = Math.max(...Object.values(nodePositions).map(p => p.x + NODE_W)) + 40;
  const maxY = Math.max(...Object.values(nodePositions).map(p => p.y + NODE_H)) + 40;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: "system-ui", background: "#0d1117", color: "#c9d1d9" }}>
      {/* Top nav — group labels */}
      <div style={{ borderBottom: "1px solid #30363d" }}>
        <div style={{ display: "flex", gap: 0, padding: "0 16px" }}>
          {navGroups.map(g => {
            const isActive = activeGroup.id === g.id;
            return (
              <button key={g.id} onClick={() => {
                // Switch to the group's first view (or stay on current if same group)
                const target = g.views[0];
                // If current view is in this group but it's not the first tab,
                // keep the current view so we don't bounce the user
                if (g.views.includes(view) && g.id === activeGroup.id) return;
                setView(target as typeof view);
              }}
                style={{
                  padding: "10px 20px",
                  background: isActive ? "#161b22" : "transparent",
                  color: isActive ? g.color : "#8b949e",
                  border: "none",
                  borderBottom: isActive ? `2px solid ${g.color}` : "2px solid transparent",
                  cursor: "pointer", fontSize: 14, fontWeight: isActive ? 600 : 400,
                  transition: "all 0.15s",
                }}>
                {g.label}
              </button>
            );
          })}
          <span style={{ marginLeft: "auto", alignSelf: "center", fontSize: 12, color: "#58a6ff" }}>Beer Lens Pipeline</span>
        </div>

        {/* Second-level tabs — visible only when group is active */}
        {activeGroup.views.length > 1 && (
          <div style={{ display: "flex", gap: 0, padding: "0 16px 0 20px", background: "#0d1117" }}>
            {activeGroup.views.map(v => {
              const labelMap: Record<string, string> = {
                pipeline: "Pipeline",
                "skill-routes": "Routes",
                planner: "Planner",
                "intent-test": "Intent Test",
                "intent-config": "Intent Config",
                cases: "Cases",
                vqa: "VQA",
                metrics: "Metrics",
                diagnosis: "Diagnosis",
                "memory-trace": "Memory Trace",
                benchmark: "Benchmark",
                "prompt-models": "Prompt & Models",
              };
              const isTabActive = view === v;
              return (
                <button key={v} onClick={() => setView(v as typeof view)}
                  style={{
                    padding: "6px 14px",
                    background: isTabActive ? "#1a2332" : "transparent",
                    color: isTabActive ? "#c9d1d9" : "#484f58",
                    border: "none",
                    borderBottom: isTabActive ? `2px solid ${activeGroup.color}` : "2px solid transparent",
                    cursor: "pointer", fontSize: 12,
                    transition: "all 0.1s",
                  }}>
                  {labelMap[v] ?? v}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {view === "cases" ? (
        <CaseView onNavigateToRawData={() => setView("raw-data")} />
      ) : view === "intent-test" ? (
        <IntentTestView />
      ) : view === "intent-config" ? (
        <IntentConfigView />
      ) : view === "skill-routes" ? (
        <SkillRoutesView />
      ) : view === "diagnosis" ? (
        <DiagnosisView />
      ) : view === "metrics" ? (
        <MetricsView />
      ) : view === "planner" ? (
        <PlannerTraceView />
      ) : view === "memory-trace" ? (
        <MemoryTraceView />
      ) : view === "raw-data" ? (
        <RawDataView />
      ) : view === "benchmark" ? (
        <BenchmarkView />
      ) : view === "prompt-models" ? (
        <PromptModelsView />
      ) : (
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {/* Pipeline canvas */}
          <div style={{ flex: 1, overflow: "auto" }}>
            <svg width={maxX} height={maxY + 60} style={{ minWidth: "100%" }}>
              {/* Connections — orthogonal lines (horizontal + vertical segments) */}
              {connections.map(([from, to], i) => {
                const f = nodePositions[from];
                const t = nodePositions[to];
                if (!f || !t) return null;
                // Start from right edge of source
                const x1 = f.x + NODE_W;
                const y1 = f.y + NODE_H / 2;
                // End at left edge of target
                const x2 = t.x;
                const y2 = t.y + NODE_H / 2;
                // Orthogonal routing: go right → vertical → left
                const midX = (x1 + x2) / 2;
                const path = `M${x1},${y1} L${midX},${y1} L${midX},${y2} L${x2},${y2}`;
                return (
                  <g key={i}>
                    <path d={path}
                      fill="none" stroke="#30363d" strokeWidth={1.5} />
                    <polygon points={`${x2-6},${y2-4} ${x2},${y2} ${x2-6},${y2+4}`} fill="#484f58" />
                  </g>
                );
              })}
              {/* Nodes */}
              {pipelineNodes.map(n => {
                const pos = nodePositions[n.id];
                if (!pos) return null;
                const isSelected = selectedNode?.id === n.id;
                const color = layerColor[n.layer];
                return (
                  <g key={n.id} onClick={() => setSelectedNode(isSelected ? null : n)}
                    style={{ cursor: "pointer" }}>
                    <rect x={pos.x} y={pos.y} width={NODE_W} height={NODE_H} rx={8}
                      fill={isSelected ? "#1a2332" : "#0d1117"}
                      stroke={isSelected ? color : "#30363d"} strokeWidth={isSelected ? 2 : 1} />
                    {/* Layer color bar on left */}
                    <rect x={pos.x} y={pos.y} width={4} height={NODE_H} rx={2} fill={color} />
                    {/* Label */}
                    {n.label.split("\n").map((line, li) => (
                      <text key={li} x={pos.x + NODE_W / 2} y={pos.y + 22 + li * 18}
                        textAnchor="middle" fill="#c9d1d9"
                        fontSize={li === 0 ? 12 : 11}
                        fontWeight={li === 0 ? 600 : 400}>
                        {line}
                      </text>
                    ))}
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Side panel: node config */}
          <div style={{ width: 380, borderLeft: "1px solid #30363d", overflow: "auto", padding: 16, background: "#0d1117" }}>
            {!selectedNode && (
              <div style={{ color: "#484f58", marginTop: 60, textAlign: "center", fontSize: 13 }}>
                点击左侧节点查看详情和配置
              </div>
            )}
            {selectedNode && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <span style={{ width: 12, height: 12, borderRadius: 3, background: layerColor[selectedNode.layer] }} />
                  <span style={{ fontSize: 11, color: "#8b949e" }}>{layers.find(l => l.id === selectedNode.layer)?.label}</span>
                </div>
                <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{selectedNode.label.split("\n")[0]}</h3>
                <p style={{ fontSize: 12, color: "#8b949e", margin: "0 0 4px" }}>
                  <code style={{ background: "#161b22", padding: "1px 6px", borderRadius: 3, fontSize: 11 }}>
                    {selectedNode.file}
                  </code>
                </p>
                <p style={{ fontSize: 12, lineHeight: 1.6, color: "#8b949e", margin: "12px 0" }}>
                  {selectedNode.description}
                </p>

                {selectedNode.configurable && selectedNode.configurable.length > 0 && (
                  <>
                    <h4 style={{ margin: "16px 0 8px", fontSize: 13, color: "#58a6ff" }}>配置参数</h4>
                    {getNodeConfig(selectedNode).map(cfg => (
                      <div key={cfg.key} style={{ marginBottom: 10 }}>
                        <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 3 }}>
                          {cfg.label} <code style={{ fontSize: 10 }}>{cfg.key}</code>
                        </label>
                        {cfg.type === "boolean" ? (
                          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                            <input type="checkbox" checked={!!cfg.value}
                              onChange={e => updateConfig(selectedNode.id, cfg.key, e.target.checked)} />
                            <span style={{ fontSize: 12 }}>{cfg.value ? "ON" : "OFF"}</span>
                          </label>
                        ) : cfg.type === "select" ? (
                          <select value={String(cfg.value)}
                            onChange={e => updateConfig(selectedNode.id, cfg.key, e.target.value)}
                            style={{ width: "100%", padding: 4, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12 }}>
                            {(cfg.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : cfg.type === "number" ? (
                          <input type="number" step="0.1" value={Number(cfg.value)}
                            onChange={e => updateConfig(selectedNode.id, cfg.key, parseFloat(e.target.value) || 0)}
                            style={{ width: "100%", padding: 4, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12 }} />
                        ) : (
                          <input type="text" value={String(cfg.value)}
                            onChange={e => updateConfig(selectedNode.id, cfg.key, e.target.value)}
                            style={{ width: "100%", padding: 4, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12 }} />
                        )}
                      </div>
                    ))}
                  </>
                )}
                {/* Intent Overrides (only for intent-classifier) */}
                {(selectedNode as any).hasOverrides && (
                  <>
                    <h4 style={{ margin: "16px 0 8px", fontSize: 13, color: "#f0883e", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      Intent 规则覆盖
                      <button onClick={addOverride}
                        style={{ fontSize: 11, padding: "2px 8px", background: "#f0883e22", color: "#f0883e", border: "1px solid #f0883e44", borderRadius: 4, cursor: "pointer" }}>
                        + Add
                      </button>
                    </h4>
                    <p style={{ fontSize: 11, color: "#8b949e", margin: "0 0 8px" }}>匹配到正则的用户输入会强制识别为指定意图（confidence=1.0，优先级最高）</p>
                    {intentOverrides.length === 0 && (
                      <p style={{ fontSize: 11, color: "#484f58" }}>暂无覆盖规则。从 Badcases 找到错误意图后，点 + Add 添加。</p>
                    )}
                    {intentOverrides.map((ov, idx) => (
                      <div key={idx} style={{ marginBottom: 8, padding: 8, background: "#161b22", borderRadius: 6, border: "1px solid #30363d" }}>
                        <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                          <input placeholder="正则 e.g. 给我推荐一杯" value={ov.regex}
                            onChange={e => updateOverride(idx, "regex", e.target.value)}
                            style={{ flex: 1, padding: 4, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 11 }} />
                          <select value={ov.intent}
                            onChange={e => updateOverride(idx, "intent", e.target.value)}
                            style={{ width: 140, padding: 4, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 11 }}>
                            {["menu_recommend","tasting_feedback","profile_query","beer_knowledge","label_check","memory_correction","unclear"].map(i => <option key={i} value={i}>{i}</option>)}
                          </select>
                          <button onClick={() => deleteOverride(idx)}
                            style={{ padding: "2px 8px", background: "#da363322", color: "#da3633", border: "1px solid #da363344", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>
                            ✕
                          </button>
                        </div>
                        <input placeholder="备注 (可选) e.g. badcase #1 修复" value={ov.note || ""}
                          onChange={e => updateOverride(idx, "note", e.target.value)}
                          style={{ width: "100%", padding: 4, background: "#0d1117", color: "#8b949e", border: "1px solid #30363d", borderRadius: 4, fontSize: 11 }} />
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Intent Test view ──

function IntentTestView() {
  const [text, setText] = useState("");
  const [hasImage, setHasImage] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [intents, setIntents] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/intent-test")
      .then(r => r.json())
      .then(d => setIntents(d.intents || []))
      .catch(() => {});
  }, []);

  const runTest = async () => {
    if (!text.trim()) return;
    setLoading(true);
    try {
      const r = await fetch("/api/intent-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, hasImage }),
      });
      setResult(await r.json());
    } catch {
      setResult({ error: "测试失败" });
    }
    setLoading(false);
  };

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 16, color: "#58a6ff" }}>意图测试</h3>
        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
          <input
            type="text"
            placeholder="输入用户文本，如：推荐一款IPA"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => e.key === "Enter" && runTest()}
            style={{ flex: 1, padding: 10, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 6, fontSize: 14 }}
          />
          <button onClick={runTest} disabled={loading}
            style={{ padding: "10px 20px", background: "#238636", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14 }}>
            {loading ? "测试中..." : "测试"}
          </button>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, cursor: "pointer", fontSize: 13, color: "#8b949e" }}>
          <input type="checkbox" checked={hasImage} onChange={e => setHasImage(e.target.checked)} />
          模拟有图片输入
        </label>

        {result && !result.error && (
          <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
              <div>
                <span style={{ fontSize: 11, color: "#8b949e" }}>主意图</span>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#58a6ff" }}>{result.primary}</div>
              </div>
              <div>
                <span style={{ fontSize: 11, color: "#8b949e" }}>来源</span>
                <div style={{ fontSize: 14, color: "#c9d1d9" }}>{result.source}</div>
              </div>
              <div>
                <span style={{ fontSize: 11, color: "#8b949e" }}>多意图</span>
                <div style={{ fontSize: 14, color: result.isMultiIntent ? "#f0883e" : "#3fb950" }}>
                  {result.isMultiIntent ? "是" : "否"}
                </div>
              </div>
            </div>
            {result.matched.length > 0 && (
              <>
                <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 6 }}>匹配的意图：</div>
                {result.matched.map((m: any, i: number) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", marginBottom: 4, background: i === 0 ? "#1a3022" : "#111", borderRadius: 4, fontSize: 13 }}>
                    <span style={{ color: i === 0 ? "#3fb950" : "#484f58", fontWeight: 600 }}>{i === 0 ? "✓" : " "}</span>
                    <span style={{ color: "#c9d1d9", fontWeight: 600 }}>{m.intent}</span>
                    <span style={{ color: "#8b949e" }}>{m.label}</span>
                    <span style={{ marginLeft: "auto", padding: "2px 8px", background: "#21262d", borderRadius: 4, fontSize: 11, color: "#d4a017" }}>
                      {(m.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </>
            )}
            {result.matched.length === 0 && (
              <div style={{ color: "#da3633", fontSize: 13 }}>未匹配任何规则 → 将走 LLM fallback 或返回 unclear</div>
            )}
          </div>
        )}
      </div>

      {/* Intent Registry panel */}
      <div style={{ width: 400, borderLeft: "1px solid #30363d", overflow: "auto", padding: 16, background: "#0d1117" }}>
        <h4 style={{ margin: "0 0 12px", fontSize: 14, color: "#58a6ff" }}>已注册意图 ({intents.length})</h4>
        {intents.map((def: any) => (
          <div key={def.id} style={{ padding: 10, marginBottom: 8, background: "#161b22", borderRadius: 6, border: "1px solid #21262d" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#c9d1d9" }}>{def.label}</span>
              <code style={{ fontSize: 10, padding: "2px 6px", background: "#0d1117", borderRadius: 3, color: "#8b949e" }}>{def.id}</code>
            </div>
            <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 6 }}>{def.description}</div>
            {def.rules.map((rule: any, ri: number) => (
              <div key={ri} style={{ fontSize: 11, padding: "3px 6px", background: "#0d1117", borderRadius: 3, marginBottom: 3, color: "#8b949e" }}>
                <code style={{ color: "#d4a017" }}>/{rule.pattern}/</code>
                <span style={{ marginLeft: 6 }}>置信度 {(rule.confidence * 100).toFixed(0)}%</span>
                {rule.requiresImage ? <span style={{ marginLeft: 6, color: "#58a6ff" }}>🖼 需要图片</span> : null}
              </div>
            ))}
            <div style={{ fontSize: 10, color: "#484f58", marginTop: 4 }}>
              Handler: {def.handler}
              {def.requiresActiveMenu ? " · 需要活跃菜单" : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Intent Config view (per PRD: 3 templates, 6 steps, models, context turns) ──

const TEMPLATE_DEFS = [
  {
    id: "general",
    name: "通用配置",
    desc: "通用基础方案，流程更轻量高效，适合样本与意图较少的场景，兼顾性能与识别效果。",
    steps: ["sample_match", "regex_match", "llm_recognize"],
    recallThreshold: 0.85,
    matchThreshold: 0.85,
  },
  {
    id: "high_recall",
    name: "高性能召回配置",
    desc: "适合样本与意图数量较多的场景，通过候选召回提升意图识别覆盖率，推荐复杂业务使用。",
    steps: ["sample_match", "regex_match", "candidate_recall", "llm_recognize", "similarity_match"],
    recallThreshold: 0.80,
    matchThreshold: 0.85,
  },
  {
    id: "custom",
    name: "自定义配置",
    desc: "可自由调整识别步骤、阈值与模型，满足个性化业务需求，适合高级用户使用。",
    steps: ["query_rewrite", "sample_match", "regex_match", "candidate_recall", "llm_recognize", "similarity_match"],
    recallThreshold: 0.85,
    matchThreshold: 0.85,
  },
];

const STEP_LABELS: Record<string, string> = {
  query_rewrite: "Query改写",
  sample_match: "样本匹配",
  regex_match: "意图正则表达式匹配",
  candidate_recall: "候选召回",
  llm_recognize: "大模型识别",
  similarity_match: "意图相似度匹配",
};

const STEP_TOOLTIPS: Record<string, string> = {
  query_rewrite: "核心用于多轮对话的上下文补全。结合历史语境，将用户的省略追问还原为语义完整的指令。",
  sample_match: "基于少量标注样本进行关键词重叠度评分，快速匹配常见意图。",
  regex_match: "使用正则表达式进行精确意图匹配，适合规则明确、边界清晰的场景。",
  candidate_recall: "通过候选召回扩大意图覆盖范围，防止漏识，适合意图数量多的场景。",
  llm_recognize: "使用大语言模型进行意图推理，处理正则无法覆盖的泛化表达。",
  similarity_match: "基于向量语义相似度进行意图匹配，需要配置向量模型。",
};

function IntentConfigView() {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const r = await fetch("/api/debug-config");
      const d = await r.json();
      setConfig(d);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const save = async (updated: any) => {
    setConfig(updated);
    setSaved(true);
    await fetch("/api/debug-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    setTimeout(() => setSaved(false), 2000);
  };

  if (loading || !config) {
    return <div style={{ flex: 1, padding: 20, color: "#484f58" }}>加载配置中...</div>;
  }

  const ie = config.intentEngine || {
    template: "general",
    steps: TEMPLATE_DEFS[0].steps.map(id => ({ id, label: STEP_LABELS[id] || id, order: 0, enabled: true })),
    recallThreshold: 0.85,
    matchThreshold: 0.85,
    contextTurns: 5,
    models: { rewriteModel: "", rewritePrompt: "", intentModel: "openai/gpt-4o-mini", intentPrompt: "", vectorModel: "", vectorPrompt: "" },
  };

  const steps = ie.steps || [];
  const models = ie.models || {};

  const applyTemplate = (templateId: string) => {
    const tpl = TEMPLATE_DEFS.find(t => t.id === templateId);
    if (!tpl) return;
    const newSteps = TEMPLATE_DEFS[2].steps.map((sid, i) => ({
      id: sid,
      label: STEP_LABELS[sid] || sid,
      order: tpl.steps.includes(sid) ? tpl.steps.indexOf(sid) + 1 : 0,
      enabled: tpl.steps.includes(sid),
    }));
    save({
      ...config,
      intentEngine: {
        ...ie,
        template: templateId,
        steps: newSteps,
        recallThreshold: tpl.recallThreshold,
        matchThreshold: tpl.matchThreshold,
      },
    });
  };

  const toggleStep = (stepId: string) => {
    const newSteps = steps.map((s: any) =>
      s.id === stepId ? { ...s, enabled: !s.enabled } : s
    );
    save({ ...config, intentEngine: { ...ie, template: "custom", steps: newSteps } });
  };

  const updateField = (field: string, value: any) => {
    save({ ...config, intentEngine: { ...ie, template: ie.template, [field]: value } });
  };

  const updateModel = (field: string, value: string) => {
    save({ ...config, intentEngine: { ...ie, models: { ...models, [field]: value } } });
  };

  const isCustom = ie.template === "custom";
  const enabledCount = steps.filter((s: any) => s.enabled).length;

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 20, background: "#0d1117" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h3 style={{ margin: 0, fontSize: 16, color: "#58a6ff" }}>意图识别引擎配置</h3>
        {saved && <span style={{ fontSize: 12, color: "#3fb950" }}>✅ 已保存</span>}
      </div>

      {/* Template selection */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
        {TEMPLATE_DEFS.map(tpl => (
          <div key={tpl.id}
            onClick={() => applyTemplate(tpl.id)}
            style={{
              padding: 16, borderRadius: 8, cursor: "pointer",
              background: ie.template === tpl.id ? "#1a3022" : "#161b22",
              border: ie.template === tpl.id ? "2px solid #3fb950" : "1px solid #30363d",
              transition: "all 0.2s",
            }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{
                width: 16, height: 16, borderRadius: "50%",
                border: ie.template === tpl.id ? "5px solid #3fb950" : "2px solid #30363d",
                background: ie.template === tpl.id ? "#3fb950" : "transparent",
                flexShrink: 0,
              }} />
              <span style={{ fontWeight: 600, fontSize: 14, color: "#c9d1d9" }}>{tpl.name}</span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "#8b949e", cursor: "help" }} title={tpl.desc}>❓</span>
            </div>
            <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.5 }}>
              {tpl.desc.slice(0, 60)}...
            </div>
            <div style={{ marginTop: 8, display: "flex", gap: 4, flexWrap: "wrap" }}>
              {tpl.steps.map(sid => (
                <span key={sid} style={{ fontSize: 10, padding: "2px 6px", background: "#21262d", borderRadius: 3, color: "#8b949e" }}>
                  {STEP_LABELS[sid] || sid}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Pipeline steps */}
      <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d", marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h4 style={{ margin: 0, fontSize: 14, color: "#c9d1d9" }}>
            意图识别步骤
            <span style={{ marginLeft: 8, fontSize: 11, color: "#8b949e", cursor: "help" }}
              title="设定识别意图的策略组合。支持样本、正则、大模型等多种引擎并行，建议开启所有步骤，以平衡识别精准度与泛化能力。">❓</span>
          </h4>
          <span style={{ fontSize: 11, color: enabledCount === 0 ? "#da3633" : "#484f58" }}>
            {enabledCount}/6 已启用
            {enabledCount === 0 && <span style={{ color: "#da3633", marginLeft: 4 }}>请至少选择一个步骤</span>}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {steps.map((step: any) => (
            <div key={step.id}
              onClick={() => isCustom && toggleStep(step.id)}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                borderRadius: 6, background: step.enabled ? "#1a3022" : "#111",
                border: step.enabled ? "1px solid #2a4632" : "1px solid #21262d",
                cursor: isCustom ? "pointer" : "default",
                opacity: step.enabled ? 1 : 0.5,
                transition: "all 0.15s",
              }}>
              <span style={{
                width: 22, height: 22, borderRadius: 4,
                background: step.enabled ? "#3fb950" : "#21262d",
                color: step.enabled ? "#fff" : "#484f58",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 700, flexShrink: 0,
              }}>
                {step.enabled ? "✓" : "—"}
              </span>
              <span style={{ fontSize: 12, color: "#8b949e", width: 20, flexShrink: 0 }}>
                {step.order || "-"}
              </span>
              <span style={{ fontSize: 13, color: step.enabled ? "#c9d1d9" : "#484f58", flex: 1 }}>
                {step.label}
              </span>
              <span style={{ fontSize: 11, color: "#484f58", cursor: "help" }}
                title={STEP_TOOLTIPS[step.id] || ""}>❓</span>
              {!isCustom && (
                <span style={{ fontSize: 10, padding: "2px 6px", background: "#21262d", borderRadius: 3, color: "#484f58" }}>
                  仅自定义可编辑
                </span>
              )}
            </div>
          ))}
        </div>
        {!isCustom && (
          <div style={{ marginTop: 10, fontSize: 11, color: "#484f58" }}>
            切换到"自定义配置"后可自由开关和调整步骤顺序
          </div>
        )}
      </div>

      {/* Thresholds */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 4px", fontSize: 13, color: "#c9d1d9" }}>
            召回阈值
            <span style={{ marginLeft: 6, fontSize: 11, color: "#8b949e", cursor: "help" }}
              title="意图初筛的宽松度（0-1）。调低可扩大候选范围，防止漏识；调高则能过滤低相关干扰，提升系统效率。">❓</span>
          </h4>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
            <input type="range" min="0" max="1" step="0.05" value={ie.recallThreshold ?? 0.85}
              onChange={e => updateField("recallThreshold", parseFloat(e.target.value))}
              style={{ flex: 1 }} />
            <span style={{ fontSize: 16, fontWeight: 700, color: "#d4a017", width: 36, textAlign: "right" }}>
              {(ie.recallThreshold ?? 0.85).toFixed(2)}
            </span>
          </div>
        </div>
        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 4px", fontSize: 13, color: "#c9d1d9" }}>
            匹配阈值
            <span style={{ marginLeft: 6, fontSize: 11, color: "#8b949e", cursor: "help" }}
              title="意图最终生效的置信度门槛（0-1）。调低时系统响应更灵敏但易误答；调高时系统更严谨但拒识率会上升。">❓</span>
          </h4>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
            <input type="range" min="0" max="1" step="0.05" value={ie.matchThreshold ?? 0.85}
              onChange={e => updateField("matchThreshold", parseFloat(e.target.value))}
              style={{ flex: 1 }} />
            <span style={{ fontSize: 16, fontWeight: 700, color: "#d4a017", width: 36, textAlign: "right" }}>
              {(ie.matchThreshold ?? 0.85).toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Context turns */}
      <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d", marginBottom: 20 }}>
        <h4 style={{ margin: "0 0 4px", fontSize: 13, color: "#c9d1d9" }}>
          上下文轮数配置
          <span style={{ marginLeft: 6, fontSize: 11, color: "#8b949e", cursor: "help" }}
            title="控制多轮对话时保留的历史轮数。轮数越高对话连贯性越强，但输入长度增加，响应速度略有下降。默认5轮。">❓</span>
        </h4>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
          <input type="range" min="1" max="10" step="1" value={ie.contextTurns ?? 5}
            onChange={e => updateField("contextTurns", parseInt(e.target.value))}
            style={{ flex: 1 }} />
          <span style={{ fontSize: 16, fontWeight: 700, color: "#58a6ff", width: 36, textAlign: "right" }}>
            {ie.contextTurns ?? 5}
          </span>
          <span style={{ fontSize: 11, color: "#8b949e" }}>轮</span>
        </div>
      </div>

      {/* Model configuration */}
      <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d", marginBottom: 20 }}>
        <h4 style={{ margin: "0 0 12px", fontSize: 14, color: "#c9d1d9" }}>模型配置</h4>

        {/* Rewrite model — show if query_rewrite step enabled */}
        {steps.find((s: any) => s.id === "query_rewrite" && s.enabled) && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#c9d1d9" }}>改写模型</span>
              <span style={{ fontSize: 11, color: "#8b949e", cursor: "help" }}
                title="核心用于多轮对话的上下文补全。结合历史语境，将用户的省略追问还原为语义完整的指令，确保意图识别准确承接上文。">❓</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 3 }}>模型名称</label>
                <select value={models.rewriteModel || ""}
                  onChange={e => updateModel("rewriteModel", e.target.value)}
                  style={{ width: "100%", padding: 6, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12 }}>
                  <option value="">默认</option>
                  <option value="queryRewrite">queryRewrite</option>
                  <option value="queryRewrite01">queryRewrite01</option>
                  <option value="queryRewrite-test">queryRewrite-test</option>
                  <option value="shusheng-openchat-queryRewite">shusheng-openchat-queryRewite</option>
                  <option value="query-rewrite-model-1122">query-rewrite-model-1122</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 3 }}>多轮改写提示词</label>
                <textarea value={models.rewritePrompt || ""}
                  onChange={e => updateModel("rewritePrompt", e.target.value)}
                  rows={2}
                  placeholder="输入改写提示词..."
                  style={{ width: "100%", padding: 6, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 11, resize: "vertical", fontFamily: "monospace" }} />
              </div>
            </div>
          </div>
        )}

        {/* LLM model — show if llm_recognize step enabled */}
        {steps.find((s: any) => s.id === "llm_recognize" && s.enabled) && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#c9d1d9" }}>大语言模型</span>
              <span style={{ fontSize: 11, color: "#8b949e", cursor: "help" }}
                title="负责核心推理与回答生成。模型能力直接决定回复的智能程度，建议根据任务复杂度在性能与响应速度间取得平衡。">❓</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 3 }}>模型名称</label>
                <select value={models.intentModel || "openai/gpt-4o-mini"}
                  onChange={e => updateModel("intentModel", e.target.value)}
                  style={{ width: "100%", padding: 6, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12 }}>
                  <option value="openai/gpt-4o-mini">openai/gpt-4o-mini</option>
                  <option value="openai/gpt-4o">openai/gpt-4o</option>
                  <option value="google/gemini-2.5-flash">google/gemini-2.5-flash</option>
                  <option value="anthropic/claude-haiku">anthropic/claude-haiku</option>
                  <option value="intent-7b">intent-7b</option>
                  <option value="Qwen3-8B">Qwen3-8B</option>
                  <option value="Yunzhi-Qwen3-8B">Yunzhi-Qwen3-8B</option>
                  <option value="Yunzhi-Qwen3-PRD-8B">Yunzhi-Qwen3-PRD-8B</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 3 }}>意图识别提示词</label>
                <textarea value={models.intentPrompt || ""}
                  onChange={e => updateModel("intentPrompt", e.target.value)}
                  rows={3}
                  placeholder="输入意图识别提示词（技能映射/意图定义）..."
                  style={{ width: "100%", padding: 6, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 11, resize: "vertical", fontFamily: "monospace" }} />
              </div>
            </div>
          </div>
        )}

        {/* Vector model — show if similarity_match step enabled */}
        {steps.find((s: any) => s.id === "similarity_match" && s.enabled) && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#c9d1d9" }}>向量模型</span>
              <span style={{ fontSize: 11, color: "#8b949e", cursor: "help" }}
                title="用于语义检索的特征提取。注意：发布应用后不允许切换此模型，切换后可能导致现有知识库索引失效，如需切换请联系管理员线下操作。">❓</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 3 }}>模型名称</label>
                <select value={models.vectorModel || ""}
                  onChange={e => updateModel("vectorModel", e.target.value)}
                  style={{ width: "100%", padding: 6, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12 }}>
                  <option value="">请选择向量模型</option>
                  <option value="Qwen3-Embedding-0.6B">Qwen3-Embedding-0.6B</option>
                  <option value="text-embedding-3-small">text-embedding-3-small</option>
                  <option value="bge-large-zh">bge-large-zh</option>
                </select>
                {!models.vectorModel && (
                  <div style={{ fontSize: 10, color: "#da3633", marginTop: 4 }}>请选择一个向量模型</div>
                )}
              </div>
              <div>
                <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 3 }}>提示词（可选）</label>
                <textarea value={models.vectorPrompt || ""}
                  onChange={e => updateModel("vectorPrompt", e.target.value)}
                  rows={2}
                  placeholder="向量模型无提示词要求..."
                  style={{ width: "100%", padding: 6, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 11, resize: "vertical", fontFamily: "monospace" }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Intent Registry Editor */}
      <IntentRegistryEditor />
    </div>
  );
}

// ── Intent Registry Editor (rules, samples, prompt per intent) ──

function IntentRegistryEditor() {
  const [intents, setIntents] = useState<any[]>([]);
  const [selectedIntent, setSelectedIntent] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);

  const fetchIntents = useCallback(async () => {
    try {
      const r = await fetch("/api/intent-test");
      const d = await r.json();
      setIntents(d.intents || []);
    } catch {}
  }, []);

  useEffect(() => { fetchIntents(); }, [fetchIntents]);

  const openIntent = (intent: any) => {
    setSelectedIntent(intent);
    setEditing(JSON.parse(JSON.stringify(intent)));
  };

  if (!selectedIntent) {
    return (
      <div style={{ marginTop: 24, background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
        <h4 style={{ margin: "0 0 12px", fontSize: 14, color: "#c9d1d9" }}>意图注册表 ({intents.length})</h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
          {intents.map((intent: any) => (
            <div key={intent.id}
              onClick={() => openIntent(intent)}
              style={{
                padding: "12px 14px", borderRadius: 6, cursor: "pointer",
                background: "#0d1117", border: "1px solid #21262d",
                transition: "all 0.15s",
              }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#c9d1d9" }}>{intent.label}</span>
                <code style={{ fontSize: 10, padding: "2px 6px", background: "#21262d", borderRadius: 3, color: "#8b949e" }}>{intent.id}</code>
              </div>
              <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>{intent.description?.slice(0, 60)}...</div>
              <div style={{ display: "flex", gap: 6, fontSize: 10, color: "#484f58" }}>
                <span>规则 {intent.rules?.length || 0}</span>
                <span>样本 {intent.samples?.length || 0}</span>
                <span>槽位 {intent.slots?.length || 0}</span>
                {intent.supportsImage && <span style={{ color: "#58a6ff" }}>🖼</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 24, background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => setSelectedIntent(null)}
            style={{ padding: "4px 10px", background: "#21262d", color: "#8b949e", border: "1px solid #30363d", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>
            ← 返回
          </button>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#c9d1d9" }}>{editing?.label}</span>
          <code style={{ fontSize: 10, padding: "2px 6px", background: "#0d1117", borderRadius: 3, color: "#8b949e" }}>{editing?.id}</code>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div>
          <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 3 }}>描述</label>
          <input value={editing?.description || ""} readOnly
            style={{ width: "100%", padding: 6, background: "#0d1117", color: "#8b949e", border: "1px solid #30363d", borderRadius: 4, fontSize: 12 }} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 3 }}>Handler</label>
          <input value={editing?.handler || ""} readOnly
            style={{ width: "100%", padding: 6, background: "#0d1117", color: "#8b949e", border: "1px solid #30363d", borderRadius: 4, fontSize: 12 }} />
        </div>
      </div>

      {/* Rules */}
      <div style={{ marginBottom: 16 }}>
        <h4 style={{ margin: "0 0 8px", fontSize: 13, color: "#58a6ff" }}>
          正则规则 ({editing?.rules?.length || 0})
          <span style={{ fontSize: 11, color: "#8b949e", marginLeft: 6 }}>正向匹配 intent，负向排除 intent</span>
        </h4>
        {(editing?.rules || []).map((rule: any, ri: number) => (
          <div key={ri} style={{ display: "flex", gap: 8, marginBottom: 4, padding: "6px 8px", background: "#0d1117", borderRadius: 4, alignItems: "center" }}>
            <span style={{
              fontSize: 10, padding: "2px 6px", borderRadius: 3,
              background: rule.type === "positive" ? "#1a3022" : "#2a1a1a",
              color: rule.type === "positive" ? "#3fb950" : "#da3633",
              flexShrink: 0, width: 44, textAlign: "center",
            }}>
              {rule.type === "positive" ? "正向" : "负向"}
            </span>
            <code style={{ flex: 1, fontSize: 11, color: "#d4a017" }}>/{rule.pattern}/</code>
            <span style={{ fontSize: 11, color: "#8b949e", flexShrink: 0 }}>
              {rule.requiresImage ? "🖼 " : ""}{(rule.confidence * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>

      {/* Samples */}
      <div style={{ marginBottom: 16 }}>
        <h4 style={{ margin: "0 0 8px", fontSize: 13, color: "#58a6ff" }}>
          样本 Query ({editing?.samples?.length || 0})
          <span style={{ fontSize: 11, color: "#8b949e", marginLeft: 6 }}>用于关键词重叠度匹配</span>
        </h4>
        {(editing?.samples || []).map((sample: any, si: number) => (
          <div key={si} style={{ display: "flex", gap: 8, marginBottom: 4, padding: "6px 8px", background: "#0d1117", borderRadius: 4, alignItems: "center" }}>
            <span style={{ flex: 1, fontSize: 12, color: "#c9d1d9" }}>"{sample.text}"</span>
            <span style={{ fontSize: 11, color: "#8b949e" }}>权重 {(sample.weight * 100).toFixed(0)}%</span>
            {sample.note && <span style={{ fontSize: 10, color: "#484f58", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={sample.note}>{sample.note}</span>}
          </div>
        ))}
      </div>

      {/* Prompt */}
      {editing?.prompt && (
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ margin: "0 0 8px", fontSize: 13, color: "#58a6ff" }}>LLM 边界 Prompt</h4>
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 3 }}>System Prompt（意图边界定义）</label>
            <textarea value={editing.prompt.systemPrompt || ""} readOnly rows={3}
              style={{ width: "100%", padding: 8, background: "#0d1117", color: "#8b949e", border: "1px solid #30363d", borderRadius: 4, fontSize: 11, resize: "vertical", fontFamily: "monospace" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 3 }}>正例</label>
              {(editing.prompt.examples || []).map((ex: string, i: number) => (
                <div key={i} style={{ fontSize: 11, color: "#3fb950", padding: "2px 6px", background: "#0d1117", borderRadius: 3, marginBottom: 2 }}>✓ {ex}</div>
              ))}
            </div>
            <div>
              <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 3 }}>负例</label>
              {(editing.prompt.negativeExamples || []).map((ex: string, i: number) => (
                <div key={i} style={{ fontSize: 11, color: "#da3633", padding: "2px 6px", background: "#0d1117", borderRadius: 3, marginBottom: 2 }}>✗ {ex}</div>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 3 }}>消歧指南</label>
            <textarea value={editing.prompt.disambiguation || ""} readOnly rows={2}
              style={{ width: "100%", padding: 8, background: "#0d1117", color: "#8b949e", border: "1px solid #30363d", borderRadius: 4, fontSize: 11, resize: "vertical", fontFamily: "monospace" }} />
          </div>
        </div>
      )}

      {/* Slots */}
      {(editing?.slots || []).length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ margin: "0 0 8px", fontSize: 13, color: "#58a6ff" }}>槽位定义 ({editing.slots.length})</h4>
          {(editing.slots || []).map((slot: any, si: number) => (
            <div key={si} style={{ display: "flex", gap: 8, marginBottom: 4, padding: "6px 8px", background: "#0d1117", borderRadius: 4, alignItems: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#c9d1d9", width: 100 }}>{slot.label}</span>
              <code style={{ fontSize: 11, color: "#8b949e" }}>{slot.name}</code>
              <span style={{ fontSize: 10, padding: "2px 6px", background: "#21262d", borderRadius: 3, color: "#8b949e" }}>{slot.type}</span>
              {slot.pattern && <code style={{ fontSize: 11, color: "#d4a017" }}>/{slot.pattern}/</code>}
              {slot.required && <span style={{ fontSize: 10, color: "#da3633" }}>必填</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Metrics Dashboard view ──

const BADCASE_LABELS = [
  { key: "intent_wrong", label: "意图错误", color: "#da3633" },
  { key: "ocr_wrong", label: "OCR错误", color: "#f0883e" },
  { key: "data_missing", label: "数据缺失", color: "#d4a017" },
  { key: "recommendation_bad", label: "推荐不好", color: "#bc8c14" },
  { key: "hallucination", label: "幻觉/编造", color: "#e05555" },
  { key: "memory_wrong", label: "记忆错误", color: "#a855f7" },
  { key: "response_bad", label: "回复不好", color: "#6c757d" },
];

function MetricsView() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const r = await fetch("/api/metrics");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setData(d);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 10000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  if (loading) {
    return <div style={{ flex: 1, padding: 40, color: "#484f58", textAlign: "center" }}>加载中...</div>;
  }

  if (error && !data) {
    return (
      <div style={{ flex: 1, padding: 40, textAlign: "center" }}>
        <div style={{ color: "#da3633", fontSize: 16, marginBottom: 8 }}>加载失败</div>
        <div style={{ color: "#484f58", fontSize: 12 }}>{error}</div>
        <button onClick={() => { setLoading(true); fetchMetrics(); }}
          style={{ marginTop: 12, padding: "8px 16px", background: "#21262d", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>
          重试
        </button>
      </div>
    );
  }

  const ov = data.overview || {};
  const funnel = data.funnel || {};
  const quality = data.quality || {};
  const badcases = data.badcases || {};
  const modelTools = data.modelTools || {};
  const memory = data.memory || {};
  const intentDist = data.intentDistribution || {};
  const evalData = data.eval || {};
  const evalRun = evalData.latestRun || null;
  const evalTrend = evalData.regressionTrend || { runs: [], passRateTrend: [], intentTrends: {}, rootCauseTrend: {} };

  const totalTurns = ov.turnCount ?? 0;
  const isEmpty = totalTurns === 0 && (funnel.imageUploaded ?? 0) === 0 && (ov.badcaseRate ?? 0) === 0;

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 16, color: "#58a6ff" }}>BI 指标看板</h3>
        <div style={{ fontSize: 11, color: "#484f58" }}>
          每10秒刷新 · {data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : ""}
          {isEmpty && <span style={{ marginLeft: 8, color: "#d4a017" }}>⚠ 暂无数据</span>}
        </div>
      </div>

      {/* ── 1. Overview Cards ── */}
      <SectionTitle title="总览" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
        <MetricCard label="总调用次数" value={ov.turnCount ?? 0} unit="次" color="#58a6ff" />
        <MetricCard label="图片轮次" value={ov.imageTurnCount ?? 0} unit="次" color="#00cec9" />
        <MetricCard label="推荐成功率" value={ov.recommendationSuccessRate != null ? (ov.recommendationSuccessRate * 100).toFixed(1) : "0.0"} unit="%" color={ov.recommendationSuccessRate > 0.8 ? "#3fb950" : "#d4a017"} />
        <MetricCard label="平均延迟" value={ov.avgLatencyMs ?? 0} unit="ms" color="#3fb950" warn={(ov.avgLatencyMs ?? 0) > 3000} />
        <MetricCard label="Badcase 率" value={ov.badcaseRate != null ? (ov.badcaseRate * 100).toFixed(1) : "0.0"} unit="%" color={ov.badcaseRate > 0.3 ? "#da3633" : ov.badcaseRate > 0.1 ? "#d4a017" : "#3fb950"} warn={ov.badcaseRate > 0.3} />
        <MetricCard label="Goodcase 率" value={ov.goodcaseRate != null ? (ov.goodcaseRate * 100).toFixed(1) : "0.0"} unit="%" color={ov.goodcaseRate > 0.7 ? "#3fb950" : "#d4a017"} />
      </div>

      {/* ── 2. Funnel ── */}
      <SectionTitle title="链路漏斗" />
      <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d", marginBottom: 20 }}>
        {isEmpty ? (
          <EmptyPlaceholder />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <FunnelBar label="📷 图片上传" value={funnel.imageUploaded ?? 0} max={Math.max(totalTurns, 1)} color="#58a6ff" />
            <FunnelBar label="🔍 OCR 候选提取" value={funnel.ocrCandidatesExtracted ?? 0} max={Math.max(funnel.imageUploaded ?? 0, 1)} color="#6c5ce7" />
            <FunnelBar label="🗄 Beer DB 查询" value={funnel.beerDbLookupTotal ?? 0} max={Math.max(totalTurns, 1)} color="#00cec9" />
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 11 }}>
              <span style={{ color: "#8b949e" }}>Beer DB 命中率</span>
              <span style={{ color: (funnel.beerDbHitRate ?? 0) > 0.5 ? "#3fb950" : "#d4a017" }}>{((funnel.beerDbHitRate ?? 0) * 100).toFixed(1)}%</span>
            </div>
            <FunnelBar label="🤖 推荐生成" value={funnel.recommendationGenerated ?? 0} max={Math.max(totalTurns, 1)} color="#e17055" />
            <FunnelBar label="🔄 追问过滤" value={funnel.followupTurns ?? 0} max={Math.max(totalTurns, 1)} color="#0984e3" />
            <FunnelBar label="🍺 品饮反馈" value={funnel.tastingFeedbackRecorded ?? 0} max={Math.max(totalTurns, 1)} color="#3fb950" />
          </div>
        )}
      </div>

      {/* ── 3. Badcase & Intent Distribution ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "#58a6ff" }}>Badcase 标签分布</h4>
          {Object.keys(badcases.tagDistribution || {}).length === 0 ? (
            <EmptyPlaceholder />
          ) : (
            Object.entries(badcases.tagDistribution || {}).sort(([, a], [, b]) => (b as number) - (a as number)).map(([key, count]) => {
              const def = BADCASE_LABELS.find(l => l.key === key);
              return (
                <ProgressBar key={key}
                  label={def?.label ?? key}
                  value={count as number}
                  max={Math.max(...Object.values(badcases.tagDistribution).map(v => v as number), 1)}
                  color={def?.color ?? "#6c757d"} />
              );
            })
          )}
        </div>

        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "#58a6ff" }}>意图分布 & Badcase 率</h4>
          {Object.keys(intentDist).length === 0 ? (
            <EmptyPlaceholder />
          ) : (
            <>
              {Object.entries(intentDist).sort(([, a], [, b]) => (b as number) - (a as number)).map(([name, count]) => {
                const badRate = badcases.badcaseByIntent?.[name] ?? 0;
                return (
                  <div key={name} style={{ marginBottom: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
                      <span style={{ color: "#8b949e" }}>{name}</span>
                      <span style={{ color: "#c9d1d9" }}>{count as number} <span style={{ color: badRate > 0.3 ? "#da3633" : "#484f58", fontSize: 10 }}>(badcase {(badRate * 100).toFixed(0)}%)</span></span>
                    </div>
                    <div style={{ height: 4, background: "#0d1117", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.min(100, ((count as number) / Math.max(totalTurns, 1)) * 100)}%`, background: "#00cec9", borderRadius: 2 }} />
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* ── 4. Quality ── */}
      <SectionTitle title="质量指标" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "#58a6ff" }}>错误类别分布</h4>
          {isEmpty ? <EmptyPlaceholder /> : (
            <>
              <BadcaseRow label="OCR 错误" count={quality.ocrWrongCount ?? 0} color="#f0883e" />
              <BadcaseRow label="意图错误" count={quality.intentWrongCount ?? 0} color="#da3633" />
              <BadcaseRow label="数据缺失" count={quality.dataMissingCount ?? 0} color="#d4a017" />
              <BadcaseRow label="推荐不好" count={quality.recommendationBadCount ?? 0} color="#bc8c14" />
              <BadcaseRow label="幻觉/编造" count={quality.hallucinationCount ?? 0} color="#e05555" />
              <BadcaseRow label="记忆错误" count={quality.memoryWrongCount ?? 0} color="#a855f7" />
            </>
          )}
        </div>

        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "#58a6ff" }}>护栏 & 异常</h4>
          {isEmpty ? <EmptyPlaceholder /> : (
            <>
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                  <span style={{ color: "#8b949e" }}>护栏拦截率</span>
                  <span style={{ color: (quality.guardrailBlockRate ?? 0) > 0.1 ? "#da3633" : "#3fb950" }}>{((quality.guardrailBlockRate ?? 0) * 100).toFixed(1)}%</span>
                </div>
                <div style={{ height: 6, background: "#0d1117", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(100, ((quality.guardrailBlockRate ?? 0) * 100))}%`, background: (quality.guardrailBlockRate ?? 0) > 0.1 ? "#da3633" : "#3fb950", borderRadius: 3 }} />
                </div>
              </div>
              <div style={{ fontSize: 11, color: "#8b949e" }}>
                总计: 已标记 {Object.values(quality).reduce((s: number, v) => s + (typeof v === "number" ? v : 0), 0) - (quality.guardrailBlockRate ?? 0)} 个 badcase
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── 5. Model / Tools Health ── */}
      <SectionTitle title="模型 / 工具健康" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "#58a6ff" }}>模型调用分布</h4>
          {Object.keys(modelTools.modelCallCount || {}).length === 0 ? (
            <EmptyPlaceholder />
          ) : (
            <>
              {Object.entries(modelTools.modelCallCount || {}).map(([kind, count]) => (
                <div key={kind} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 12 }}>
                  <span style={{ color: kind === "llm" ? "#58a6ff" : kind === "rule" ? "#3fb950" : "#d4a017" }}>
                    {kind === "rule" ? "⚡ 规则匹配" : kind === "llm" ? "🧠 LLM 识别" : "⬇ 兜底"}
                  </span>
                  <span style={{ color: "#c9d1d9", fontWeight: 600 }}>{count as number}</span>
                </div>
              ))}
              <div style={{ marginTop: 8, padding: "6px 0", borderTop: "1px solid #30363d", fontSize: 12, display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#8b949e" }}>Beer DB 命中率</span>
                <span style={{ color: (modelTools.beerDbHitRate ?? 0) > 0.5 ? "#3fb950" : "#d4a017", fontWeight: 600 }}>{((modelTools.beerDbHitRate ?? 0) * 100).toFixed(1)}%</span>
              </div>
            </>
          )}
        </div>

        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "#58a6ff" }}>Handler 错误分布</h4>
          {modelTools.handlerErrorRate && Object.keys(modelTools.handlerErrorRate).length > 0 ? (
            Object.entries(modelTools.handlerErrorRate).sort(([, a], [, b]) => (b as number) - (a as number)).map(([name, count]) => (
              <div key={name} style={{ display: "flex", justifyContent: "space-between", padding: "6px 8px", marginBottom: 4, background: "#0d1117", borderRadius: 4, fontSize: 12 }}>
                <span style={{ color: "#da3633" }}>{name}</span>
                <span style={{ color: "#c9d1d9", fontWeight: 600 }}>{count as number} 次</span>
              </div>
            ))
          ) : (
            <div style={{ color: "#3fb950", fontSize: 12 }}>✅ 无 Handler 错误</div>
          )}
        </div>
      </div>

      {/* ── 6. Memory ── */}
      <SectionTitle title="记忆指标" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        <MetricCard label="品饮记录" value={memory.tastingEpisodeCount ?? 0} unit="条" color="#3fb950" />
        <MetricCard label="画像更新" value={memory.profileUpdateCount ?? 0} unit="次" color="#58a6ff" />
        <MetricCard label="记忆使用" value={memory.memoryUsedCount ?? 0} unit="次" color="#00cec9" />
        <MetricCard label="记忆纠正" value={memory.memoryCorrectionCount ?? 0} unit="次" color="#a855f7" />
      </div>

      {/* ── 7. Evaluation Platform ── */}
      <SectionTitle title="评测平台 — 测试集版本" />
      <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d", marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <span style={{ fontSize: 13, color: "#8b949e", marginRight: 8 }}>测试集版本</span>
            <code style={{ fontSize: 14, color: "#58a6ff", fontWeight: 600 }}>{evalData.testSetVersion || "unknown"}</code>
          </div>
          {evalRun && (
            <div style={{ display: "flex", gap: 16 }}>
              <span style={{ fontSize: 11, color: "#8b949e" }}>通过: <strong style={{ color: "#3fb950" }}>{evalRun.pass}</strong></span>
              <span style={{ fontSize: 11, color: "#8b949e" }}>失败: <strong style={{ color: "#da3633" }}>{evalRun.fail}</strong></span>
              <span style={{ fontSize: 11, color: "#8b949e" }}>总数: <strong style={{ color: "#c9d1d9" }}>{evalRun.total}</strong></span>
            </div>
          )}
        </div>

        {evalRun ? (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 6 }}>整体通过率</div>
            <div style={{ height: 20, background: "#0d1117", borderRadius: 6, overflow: "hidden", display: "flex" }}>
              <div style={{ width: `${(evalRun.passRate * 100)}%`, background: "#3fb950", borderRadius: 6, transition: "width 0.5s", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 40 }}>
                <span style={{ fontSize: 10, color: "#fff", fontWeight: 600 }}>{(evalRun.passRate * 100).toFixed(0)}%</span>
              </div>
            </div>
          </div>
        ) : (
          <EmptyPlaceholder />
        )}
      </div>

      {/* ── 8. Pass Rate Trend ── */}
      <SectionTitle title="通过率趋势" />
      <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d", marginBottom: 20 }}>
        {evalTrend.passRateTrend.length === 0 ? (
          <EmptyPlaceholder />
        ) : (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 80, padding: "10px 0" }}>
            {evalTrend.passRateTrend.map((pt: any, i: number) => {
              const pct = (pt.rate ?? 0) * 100;
              const h = Math.max(8, pct * 0.7);
              return (
                <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 10, color: "#c9d1d9" }}>{pct.toFixed(0)}%</span>
                  <div style={{ width: "100%", height: h, background: pct > 60 ? "#3fb950" : pct > 40 ? "#d4a017" : "#da3633", borderRadius: 3, transition: "height 0.3s" }} />
                  <span style={{ fontSize: 9, color: "#484f58" }}>{pt.time?.slice(5) || ""}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 9. Intent Pass Rate ── */}
      <SectionTitle title="意图维度通过率" />
      <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d", marginBottom: 20 }}>
        {Object.keys(evalData.intentPassRates || {}).length === 0 ? (
          <EmptyPlaceholder />
        ) : (
          Object.entries(evalData.intentPassRates).sort(([, a], [, b]) => (a as number) - (b as number)).map(([intent, rate]) => {
            const pct = (rate as number) * 100;
            const color = pct > 70 ? "#3fb950" : pct > 40 ? "#d4a017" : "#da3633";
            return (
              <ProgressBar key={intent} label={intent} value={pct} max={100} color={color} />
            );
          })
        )}
      </div>

      {/* ── 10. Root Cause Distribution ── */}
      <SectionTitle title="Badcase Root Cause 分布" />
      <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d", marginBottom: 20 }}>
        {Object.keys(evalData.rootCauseDist || {}).length === 0 ? (
          <EmptyPlaceholder />
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {Object.entries(evalData.rootCauseDist).sort(([, a], [, b]) => (b as number) - (a as number)).map(([cause, count]) => {
              const colors: Record<string, string> = { ocr: "#f0883e", intent: "#da3633", beer_db: "#d4a017", recommendation: "#bc8c14", prompt: "#a29bfe", model: "#0984e3", memory: "#a855f7", guardrail: "#ff6b6b", unknown: "#484f58" };
              return (
                <div key={cause} style={{ padding: "8px 14px", background: (colors[cause] || "#484f58") + "22", borderRadius: 8, border: `1px solid ${colors[cause] || "#484f58"}44` }}>
                  <div style={{ fontSize: 12, color: colors[cause] || "#8b949e", fontWeight: 600, marginBottom: 2 }}>{cause}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#c9d1d9" }}>{count as number} <span style={{ fontSize: 11, fontWeight: 400, color: "#8b949e" }}>次</span></div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 11. Model / Prompt / Tool Dimension Failure Rate ── */}
      <SectionTitle title="分维度失败率" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20, marginBottom: 20 }}>
        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "#58a6ff" }}>模型维度失败率</h4>
          {Object.keys(evalData.modelFailRates || {}).length === 0 ? (
            <EmptyPlaceholder />
          ) : (
            Object.entries(evalData.modelFailRates).sort(([, a], [, b]) => (b as number) - (a as number)).map(([intent, rate]) => (
              <BadcaseRow key={intent} label={intent} count={Math.round((rate as number) * 100)} color="#0984e3" />
            ))
          )}
        </div>

        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "#58a6ff" }}>工具维度失败率</h4>
          {Object.keys(evalData.toolFailRates || {}).length === 0 ? (
            <EmptyPlaceholder />
          ) : (
            Object.entries(evalData.toolFailRates).sort(([, a], [, b]) => (b as number) - (a as number)).map(([tool, rate]) => (
              <BadcaseRow key={tool} label={tool} count={Math.round((rate as number) * 100)} color="#f0883e" />
            ))
          )}
        </div>

        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "#58a6ff" }}>Prompt 维度失败率</h4>
          {Object.keys(evalData.promptFailRates || {}).length === 0 ? (
            <EmptyPlaceholder />
          ) : (
            Object.entries(evalData.promptFailRates).sort(([, a], [, b]) => (b as number) - (a as number)).map(([intent, rate]) => (
              <BadcaseRow key={intent} label={intent} count={Math.round((rate as number) * 100)} color="#a29bfe" />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──

function SectionTitle({ title }: { title: string }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 600, color: "#8b949e", marginBottom: 10, paddingLeft: 2 }}>
      {title}
    </div>
  );
}

function EmptyPlaceholder() {
  return (
    <div style={{ color: "#484f58", fontSize: 12, textAlign: "center", padding: "20px 0" }}>
      暂无数据
    </div>
  );
}

function MetricCard({ label, value, unit, color, warn }: { label: string; value: string | number; unit: string; color: string; warn?: boolean }) {
  return (
    <div style={{ background: warn ? "#2a1a1a" : "#161b22", borderRadius: 8, padding: 16, border: `1px solid ${warn ? "#3a2020" : "#30363d"}` }}>
      <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: warn ? "#da3633" : color }}>
        {value}<span style={{ fontSize: 14, marginLeft: 4, fontWeight: 400, color: "#484f58" }}>{unit}</span>
      </div>
    </div>
  );
}

function ProgressBar({ label, value, max, color, warn }: { label: string; value: number; max: number; color: string; warn?: boolean }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
        <span style={{ color: "#8b949e" }}>{label}</span>
        <span style={{ color: warn ? "#da3633" : "#c9d1d9" }}>{value} ({(pct).toFixed(1)}%)</span>
      </div>
      <div style={{ height: 6, background: "#0d1117", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: warn ? "#da3633" : color, borderRadius: 3, transition: "width 0.3s" }} />
      </div>
    </div>
  );
}

function FunnelBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ width: 140, fontSize: 11, color: "#8b949e", flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 18, background: "#0d1117", borderRadius: 4, overflow: "hidden", position: "relative" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 4, transition: "width 0.3s", minWidth: value > 0 ? 4 : 0 }} />
      </div>
      <span style={{ width: 50, fontSize: 12, fontWeight: 600, color: "#c9d1d9", textAlign: "right", flexShrink: 0 }}>{value}</span>
    </div>
  );
}

function BadcaseRow({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", fontSize: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
        <span style={{ color: count > 0 ? "#c9d1d9" : "#484f58" }}>{label}</span>
      </div>
      <span style={{ color: count > 0 ? (color ?? "#c9d1d9") : "#484f58", fontWeight: 600 }}>{count}</span>
    </div>
  );
}

function safeJsonStringify(val: unknown): string {
  try {
    return JSON.stringify(val ?? null, null, 2);
  } catch {
    return String(val);
  }
}

function SkillRoutesView() {
  const [routes, setRoutes] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [diagnosis, setDiagnosis] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/skill-routes")
      .then((r) => r.json())
      .then((d) => {
        const list = Array.isArray(d) ? d : [];
        setRoutes(list);
        setSelected(list[0] || null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const runDiagnosis = async (intent: string) => {
    const r = await fetch("/api/skill-routes/diagnose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent,
        context: {
          hasImage: (document.getElementById("route-has-image") as HTMLInputElement)?.checked ?? false,
          lastMenu: (document.getElementById("route-last-menu") as HTMLInputElement)?.checked ?? false,
          activeBeer: (document.getElementById("route-active-beer") as HTMLInputElement)?.checked ?? false,
          profileSummary: (document.getElementById("route-profile") as HTMLInputElement)?.checked ?? false,
          tastingHistory: (document.getElementById("route-history") as HTMLInputElement)?.checked ?? false,
        },
      }),
    });
    setDiagnosis(await r.json().catch(() => ({ error: "诊断失败" })));
  };

  if (loading) return <div style={{ flex: 1, padding: 40, color: "#484f58" }}>加载路由表...</div>;

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      <div style={{ width: 360, borderRight: "1px solid #30363d", overflow: "auto", padding: 16 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16, color: "#58a6ff" }}>技能路由表</h3>
        {routes.length === 0 && <EmptyPlaceholder />}
        {routes.map((route) => (
          <button key={route.intent} onClick={() => { setSelected(route); setDiagnosis(null); }}
            style={{ width: "100%", textAlign: "left", padding: 10, marginBottom: 6, borderRadius: 6, cursor: "pointer", background: selected?.intent === route.intent ? "#1a2332" : "#161b22", color: "#c9d1d9", border: selected?.intent === route.intent ? "1px solid #58a6ff" : "1px solid #30363d" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#58a6ff" }}>{route.intent}</div>
            <div style={{ fontSize: 11, color: "#8b949e", marginTop: 3 }}>{route.handler || "-"} · priority {route.priority ?? "-"}</div>
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {!selected ? <EmptyPlaceholder /> : (
          <>
            <h3 style={{ margin: "0 0 12px", fontSize: 16, color: "#58a6ff" }}>{selected.intent}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
              <InfoPanel title="Handler" value={selected.handler || "-"} />
              <InfoPanel title="Fallback" value={selected.fallbackIntent || selected.fallbackReply || "无"} />
              <InfoPanel title="Required Context" value={(selected.requiredContext || []).join(", ") || "无需"} />
              <InfoPanel title="Required Tools" value={(selected.requiredTools || []).join(", ") || "无"} />
            </div>
            {selected.notes && <pre style={preStyle}>{selected.notes}</pre>}
            <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, padding: 14 }}>
              <h4 style={{ margin: "0 0 10px", fontSize: 13, color: "#f0883e" }}>路由诊断模拟</h4>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                {[
                  ["route-has-image", "有图片"],
                  ["route-last-menu", "有酒单"],
                  ["route-active-beer", "活跃啤酒"],
                  ["route-profile", "有画像"],
                  ["route-history", "有品饮历史"],
                ].map(([id, label]) => (
                  <label key={id} style={{ fontSize: 12, color: "#8b949e" }}><input id={id} type="checkbox" /> {label}</label>
                ))}
              </div>
              <button onClick={() => runDiagnosis(selected.intent)}
                style={{ padding: "6px 14px", borderRadius: 4, border: "1px solid #f0883e44", background: "#f0883e22", color: "#f0883e", cursor: "pointer" }}>
                运行诊断
              </button>
              {diagnosis && <pre style={{ ...preStyle, marginTop: 12 }}>{safeJsonStringify(diagnosis)}</pre>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DiagnosisView() {
  const [traceId, setTraceId] = useState("");
  const [diagnosis, setDiagnosis] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const pickDiagnosis = (trace: any) =>
    trace?.stages?.diagnosis || trace?.output?.diagnosis || trace?.diagnosis || null;

  const loadTrace = async (id = traceId) => {
    if (!id.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/traces/${encodeURIComponent(id.trim())}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const trace = await r.json();
      setDiagnosis(pickDiagnosis(trace) || trace);
      setTraceId(id.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
      setDiagnosis(null);
    } finally {
      setLoading(false);
    }
  };

  const loadLatestBadcase = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/cases?label=recommendation_bad");
      const list = await r.json();
      const first = Array.isArray(list) ? list[0] : null;
      if (!first?.traceId) throw new Error("没有 recommendation_bad case");
      await loadTrace(first.traceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
      setDiagnosis(null);
      setLoading(false);
    }
  };

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
      <h3 style={{ margin: "0 0 12px", fontSize: 16, color: "#58a6ff" }}>推荐链路诊断</h3>
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <input value={traceId} onChange={(e) => setTraceId(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadTrace()}
          placeholder="traceId，例如 trace_xxx"
          style={{ flex: 1, padding: 8, borderRadius: 6, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d" }} />
        <button onClick={() => loadTrace()} disabled={loading} style={primaryButtonStyle}>{loading ? "加载中" : "加载"}</button>
        <button onClick={loadLatestBadcase} disabled={loading} style={secondaryButtonStyle}>最新推荐 Badcase</button>
      </div>
      {error && <div style={{ color: "#da3633", marginBottom: 12, fontSize: 12 }}>{error}</div>}
      {!diagnosis ? <EmptyPlaceholder /> : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
            <MetricCard label="OCR 候选" value={diagnosis.ocrCandidateCount ?? "?"} unit="个" color="#6c5ce7" />
            <MetricCard label="DB 命中" value={`${diagnosis.dbHitCount ?? 0}/${diagnosis.dbLookupCount ?? 0}`} unit="" color="#00cec9" />
            <MetricCard label="数据缺失" value={diagnosis.dataMissingCount ?? 0} unit="项" color={(diagnosis.dataMissingCount ?? 0) > 0 ? "#da3633" : "#3fb950"} />
            <MetricCard label="使用画像" value={diagnosis.memoryUsed ? "是" : "否"} unit="" color={diagnosis.memoryUsed ? "#3fb950" : "#484f58"} />
          </div>
          {diagnosis.topPickReason && <InfoPanel title="Top Pick 理由" value={diagnosis.topPickReason} />}
          {Array.isArray(diagnosis.riskFlags) && diagnosis.riskFlags.length > 0 && <InfoPanel title="风险标记" value={diagnosis.riskFlags.join(", ")} />}
          <pre style={{ ...preStyle, marginTop: 16 }}>{safeJsonStringify(diagnosis)}</pre>
        </>
      )}
    </div>
  );
}

function PlannerTraceView() {
  const [cases, setCases] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [trace, setTrace] = useState<any>(null);

  useEffect(() => {
    fetch("/api/cases?status=&label=")
      .then((r) => r.json())
      .then((list) => setCases((Array.isArray(list) ? list : []).filter((c) =>
        c.rootCause === "planner" || c.rootCause === "tool_route" || c.trace?.planner || c.planner,
      )))
      .catch(() => {});
  }, []);

  const openCase = async (c: any) => {
    setSelected(c);
    const r = await fetch(`/api/cases/${c.id}`);
    const d = await r.json().catch(() => ({}));
    setTrace(d.trace || null);
  };

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      <div style={{ width: 380, borderRight: "1px solid #30363d", padding: 16, overflow: "auto" }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16, color: "#58a6ff" }}>Planner Trace</h3>
        {cases.length === 0 && <EmptyPlaceholder />}
        {cases.map((c) => (
          <button key={c.id} onClick={() => openCase(c)}
            style={{ width: "100%", textAlign: "left", padding: 10, marginBottom: 6, borderRadius: 6, cursor: "pointer", background: selected?.id === c.id ? "#1a2332" : "#161b22", color: "#c9d1d9", border: selected?.id === c.id ? "1px solid #58a6ff" : "1px solid #30363d" }}>
            <div style={{ fontSize: 12 }}>{c.input?.text?.slice(0, 80) || c.id}</div>
            <div style={{ fontSize: 10, color: "#8b949e", marginTop: 3 }}>{c.rootCause || "planner"} · {c.traceId}</div>
          </button>
        ))}
      </div>
      <div style={{ flex: 1, padding: 20, overflow: "auto" }}>
        {!selected ? <EmptyPlaceholder /> : (
          <>
            <InfoPanel title="输入" value={selected.input?.text || "-"} />
            <InfoPanel title="触发原因" value={trace?.planner?.diagnostics?.triggerReason || selected.intentRouteReason || "-"} />
            {Array.isArray(trace?.planner?.plan?.steps) ? (
              <div style={{ marginTop: 16 }}>
                {trace.planner.plan.steps.map((step: any, i: number) => (
                  <div key={step.id || i} style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, padding: 12, marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <span style={{ color: "#58a6ff", fontWeight: 600 }}>{i + 1}. {step.tool}</span>
                      <span style={{ color: step.status === "failed" ? "#da3633" : step.status === "completed" ? "#3fb950" : "#8b949e", fontSize: 12 }}>{step.status}</span>
                    </div>
                    <div style={{ color: "#8b949e", fontSize: 12, marginTop: 4 }}>{step.purpose}</div>
                    {(step.error || step.output) && <pre style={{ ...preStyle, marginTop: 8 }}>{safeJsonStringify(step.error || step.output)}</pre>}
                  </div>
                ))}
              </div>
            ) : (
              <pre style={{ ...preStyle, marginTop: 16 }}>{safeJsonStringify(trace || selected)}</pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const RAW_IMAGE_QUALITY_OPTIONS = [
  { value: "good", label: "清晰可用" },
  { value: "ok", label: "勉强可读" },
  { value: "bad", label: "模糊不清" },
  { value: "unusable", label: "完全不适用" },
];

const RAW_STYLE_OPTIONS = ["IPA", "Stout", "Lager", "Sour", "Pilsner", "Porter", "Wheat", "Saison", "Pale Ale", "Barleywine", "其他", "无法判断"];

function RawDataView() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [filter, setFilter] = useState("pending");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [labels, setLabels] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [vqaTab, setVqaTab] = useState<"raw-data" | "query">("raw-data");

  const selected = tasks[selectedIdx] || null;
  const fetchTasks = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ limit: "200" });
    if (filter) params.set("status", filter);
    const endpoint = vqaTab === "raw-data" ? "/api/raw-data/tasks" : "/api/query-tasks";
    const r = await fetch(`${endpoint}?${params}`);
    const d = await r.json().catch(() => []);
    const list = Array.isArray(d) ? d : [];
    setTasks(list);
    setSelectedIdx(0);
    setLabels(list[0]?.labels || {});
    setLoading(false);
  }, [filter, vqaTab]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  const selectTask = (idx: number) => {
    setSelectedIdx(idx);
    setLabels(tasks[idx]?.labels || {});
  };

  const updateLabel = (key: string, value: any) => setLabels((prev) => ({ ...prev, [key]: value }));

  const saveTask = async (status: "labeled" | "skipped") => {
    if (!selected) return;
    const r = await fetch(`/api/raw-data/tasks/${selected.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels, status }),
    });
    const updated = await r.json().catch(() => null);
    if (updated) {
      const next = [...tasks];
      next[selectedIdx] = updated;
      setTasks(next);
    }
  };

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      <div style={{ width: 300, borderRight: "1px solid #30363d", padding: 12, overflow: "auto" }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 16, color: "#58a6ff" }}>
          {vqaTab === "raw-data" ? "原数据标注" : "Query 标注"}
          <span style={{ marginLeft: 8, fontSize: 11, color: "#8b949e", cursor: "pointer" }}
            onClick={() => { setVqaTab(vqaTab === "raw-data" ? "query" : "raw-data"); fetchTasks(); }}>
            [{vqaTab === "raw-data" ? "切换到 Query" : "切换到 VQA"}]
          </span>
        </h3>
        <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
          {["pending", "labeled", "skipped", "exported"].map((s) => (
            <button key={s} onClick={() => setFilter(s)} style={{ ...secondaryButtonStyle, padding: "4px 8px", color: filter === s ? "#58a6ff" : "#8b949e" }}>{s}</button>
          ))}
        </div>
        {loading && <div style={{ color: "#484f58", padding: 20 }}>加载中...</div>}
        {!loading && tasks.length === 0 && <EmptyPlaceholder />}
        {tasks.map((t, i) => (
          <button key={t.id} onClick={() => selectTask(i)}
            style={{ width: "100%", textAlign: "left", padding: 8, marginBottom: 4, borderRadius: 6, cursor: "pointer", background: i === selectedIdx ? "#1a2332" : "#161b22", color: "#c9d1d9", border: i === selectedIdx ? "1px solid #58a6ff" : "1px solid #30363d" }}>
            <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {vqaTab === "raw-data" ? (t.candidateBeerName || t.title || t.id) : (t.query || t.id)}
            </div>
            <div style={{ fontSize: 10, color: "#8b949e" }}>{t.status} · {t.source}</div>
          </button>
        ))}
      </div>
      <div style={{ flex: 1, padding: 16, overflow: "auto", display: "flex", alignItems: "flex-start", justifyContent: "center" }}>
        {!selected ? <EmptyPlaceholder /> : (
          <div style={{ width: "100%", maxWidth: 760 }}>
            {vqaTab === "raw-data" ? (
              <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, minHeight: 320, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                <img src={selected.imageUrl} alt={selected.candidateBeerName || selected.title || "beer image"} style={{ maxWidth: "100%", maxHeight: 520, objectFit: "contain" }} />
              </div>
            ) : (
              <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, padding: 16 }}>
                <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 4 }}>用户输入</div>
                <div style={{ fontSize: 14, color: "#c9d1d9", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{selected.query}</div>
                {selected.intent && <div style={{ marginTop: 8, fontSize: 11, color: "#8b949e" }}>当时意图: {selected.intent}</div>}
                <div style={{ marginTop: 4, fontSize: 10, color: "#484f58" }}>来源: {selected.sourceType} · {selected.createdAt?.slice(0, 10)}</div>
              </div>
            )}
            {vqaTab === "raw-data" && <div style={{ marginTop: 10, fontSize: 11, color: "#8b949e", wordBreak: "break-all" }}>{selected.sourceUrl}</div>}
          </div>
        )}
      </div>
      <div style={{ width: 360, borderLeft: "1px solid #30363d", padding: 16, overflow: "auto" }}>
        {!selected ? <EmptyPlaceholder /> : (
          <>
            {vqaTab === "raw-data" ? (
              <>
                <h4 style={{ margin: "0 0 12px", fontSize: 14, color: "#58a6ff" }}>标注表单</h4>
                <FormInput label="啤酒名称" value={labels.beerName || ""} onChange={(v) => updateLabel("beerName", v)} />
                <FormInput label="品牌/酒厂" value={labels.brand || ""} onChange={(v) => updateLabel("brand", v)} />
                <label style={formLabelStyle}>风格</label>
                <select value={labels.style || ""} onChange={(e) => updateLabel("style", e.target.value)} style={formInputStyle}>
                  <option value="">-- 选择 --</option>
                  {RAW_STYLE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <FormInput label="ABV" value={labels.abv || ""} onChange={(v) => updateLabel("abv", v)} />
                <label style={formLabelStyle}>图片质量</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  {RAW_IMAGE_QUALITY_OPTIONS.map((opt) => (
                    <button key={opt.value} onClick={() => updateLabel("imageQuality", opt.value)}
                      style={{ ...secondaryButtonStyle, color: labels.imageQuality === opt.value ? "#58a6ff" : "#8b949e" }}>{opt.label}</button>
                  ))}
                </div>
                <label style={formLabelStyle}>可见文字</label>
                <textarea value={labels.visibleText || ""} onChange={(e) => updateLabel("visibleText", e.target.value)} rows={3} style={{ ...formInputStyle, resize: "vertical" }} />
              </>
            ) : (
              <>
                <h4 style={{ margin: "0 0 12px", fontSize: 14, color: "#58a6ff" }}>Query 标注</h4>
                <label style={formLabelStyle}>期望意图</label>
                <select value={labels.expectedIntent || ""} onChange={(e) => updateLabel("expectedIntent", e.target.value)} style={formInputStyle}>
                  <option value="">-- 选择 --</option>
                  {["menu_recommend","tasting_feedback","profile_query","beer_knowledge","label_check","memory_correction","unclear"].map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <label style={formLabelStyle}>期望回复</label>
                <textarea value={labels.expectedReply || ""} onChange={(e) => updateLabel("expectedReply", e.target.value)} rows={3} style={{ ...formInputStyle, resize: "vertical" }} placeholder="可以写关键信息，不用完整句子" />
                <label style={formLabelStyle}>是否好 case</label>
                <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                  {[{ value: "yes", label: "好 ✅" }, { value: "no", label: "不好 ❌" }, { value: "ambiguous", label: "不确定 ❓" }].map((opt) => (
                    <button key={opt.value} onClick={() => updateLabel("isGoodcase", opt.value)}
                      style={{ ...secondaryButtonStyle, color: labels.isGoodcase === opt.value ? "#58a6ff" : "#8b949e" }}>{opt.label}</button>
                  ))}
                </div>
                <label style={formLabelStyle}>场景标签</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  {["推荐","品饮","打断/追问","知识问答","记忆纠正","酒标检查","问候/闲聊"].map((tag) => {
                    const tags: string[] = labels.tags || [];
                    const active = tags.includes(tag);
                    return (
                      <button key={tag} onClick={() => updateLabel("tags", active ? tags.filter((t: string) => t !== tag) : [...tags, tag])}
                        style={{ ...secondaryButtonStyle, color: active ? "#58a6ff" : "#8b949e" }}>{tag}</button>
                    );
                  })}
                </div>
                <label style={formLabelStyle}>备注</label>
                <textarea value={labels.note || ""} onChange={(e) => updateLabel("note", e.target.value)} rows={2} style={{ ...formInputStyle, resize: "vertical" }} />
              </>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={() => saveTask("labeled")} style={{ ...primaryButtonStyle, flex: 1 }}>保存 labeled</button>
              <button onClick={() => saveTask("skipped")} style={secondaryButtonStyle}>跳过</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function InfoPanel({ title, value }: { title: string; value: string }) {
  return (
    <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, padding: 12, marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, color: "#c9d1d9", lineHeight: 1.5, wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}

function FormInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={formLabelStyle}>{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} style={formInputStyle} />
    </div>
  );
}

const preStyle: CSSProperties = {
  padding: 12,
  background: "#0d1117",
  border: "1px solid #30363d",
  borderRadius: 6,
  color: "#c9d1d9",
  fontSize: 11,
  whiteSpace: "pre-wrap",
  overflow: "auto",
};

const primaryButtonStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "none",
  background: "#238636",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
};

const secondaryButtonStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid #30363d",
  background: "#21262d",
  color: "#c9d1d9",
  cursor: "pointer",
  fontSize: 12,
};

const formLabelStyle: CSSProperties = { fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 };
const formInputStyle: CSSProperties = { width: "100%", boxSizing: "border-box", padding: 7, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12, marginBottom: 12 };

// ── Memory Trace view ──

function MemoryTraceView() {
  const [tab, setTab] = useState<"factors" | "profile" | "reflection" | "episodes">("factors");

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 20, background: "#0d1117" }}>
      <h3 style={{ margin: "0 0 16px", fontSize: 16, color: "#58a6ff" }}>记忆系统追踪</h3>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {["factors", "profile", "reflection", "episodes"].map((t) => (
          <button key={t}
            onClick={() => setTab(t as any)}
            style={{
              padding: "8px 16px", borderRadius: 6, border: "1px solid #30363d", cursor: "pointer",
              background: tab === t ? "#1a3022" : "#161b22", color: tab === t ? "#3fb950" : "#8b949e",
              fontSize: 13, fontWeight: tab === t ? 600 : 400,
            }}>
            {t === "factors" ? "Factor 事实" : t === "profile" ? "画像标签" : t === "reflection" ? "画像复核" : "品饮记录"}
          </button>
        ))}
      </div>

      {tab === "factors" && <FactorTracePanel />}
      {tab === "profile" && <ProfileTracePanel />}
      {tab === "reflection" && <ReflectionTracePanel />}
      {tab === "episodes" && <EpisodesTracePanel />}
    </div>
  );
}

function FactorTracePanel() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    fetch("/api/memory-trace?type=factors&userId=local-user")
      .then((r) => r.json()).then(setData).catch(() => {});
  }, []);

  const factors = data?.factors || [];
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ color: "#8b949e", fontSize: 13 }}>Factor 事实 ({factors.length} 条)</span>
        <span style={{ fontSize: 11, color: "#484f58" }}>
          数据分割: 时间轴核密度 · Factor 抽取: LLM · 整合: DBSCAN + LLM
        </span>
      </div>
      {factors.length === 0 && <div style={{ color: "#484f58", padding: 20, textAlign: "center" }}>暂无 Factor 数据</div>}
      {factors.map((f: any, i: number) => (
        <div key={i} style={{ padding: "10px 14px", marginBottom: 8, background: "#161b22", borderRadius: 6, border: "1px solid #30363d" }}>
          <div style={{ fontSize: 13, color: "#c9d1d9", marginBottom: 6 }}>{f.factor}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
            {f.keywords?.map((kw: string) => (
              <span key={kw} style={{ fontSize: 11, padding: "2px 8px", background: "#21262d", borderRadius: 99, color: "#8b949e" }}>{kw}</span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, fontSize: 10, color: "#484f58" }}>
            <span>时间: {f.timeRange?.[0]?.slice(0, 19) || "?"} → {f.timeRange?.[1]?.slice(0, 19) || "?"}</span>
            <span>ID: {f.id}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProfileTracePanel() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    fetch("/api/memory-trace?type=profile&userId=local-user")
      .then((r) => r.json()).then(setData).catch(() => {});
  }, []);

  const profile = data?.profile;
  if (!profile) return <div style={{ color: "#484f58", padding: 20, textAlign: "center" }}>暂无画像数据</div>;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
        <h4 style={{ margin: "0 0 10px", fontSize: 13, color: "#3fb950" }}>偏好风格</h4>
        {(profile.preferredStyles || []).map((s: any) => (
          <div key={s.value} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12 }}>
            <span style={{ color: "#c9d1d9" }}>{s.value}</span>
            <span style={{ color: "#8b949e" }}>权重 {s.weight} · {s.evidenceCount}条</span>
          </div>
        ))}
      </div>
      <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
        <h4 style={{ margin: "0 0 10px", fontSize: 13, color: "#da3633" }}>不喜欢的风格</h4>
        {(profile.dislikedStyles || []).map((s: any) => (
          <div key={s.value} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12 }}>
            <span style={{ color: "#c9d1d9" }}>{s.value}</span>
            <span style={{ color: "#8b949e" }}>权重 {s.weight} · {s.evidenceCount}条</span>
          </div>
        ))}
      </div>
      <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
        <h4 style={{ margin: "0 0 10px", fontSize: 13, color: "#58a6ff" }}>偏好风味标签</h4>
        {(profile.preferredTags || []).map((t: any) => (
          <div key={t.value} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12 }}>
            <span style={{ color: "#c9d1d9" }}>{t.value}</span>
            <span style={{ color: "#8b949e" }}>权重 {t.weight} · {t.evidenceCount}条</span>
          </div>
        ))}
      </div>
      <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
        <h4 style={{ margin: "0 0 10px", fontSize: 13, color: "#d4a017" }}>ABV 舒适区间</h4>
        {profile.abvComfortRange ? (
          <div style={{ fontSize: 24, fontWeight: 700, color: "#d4a017" }}>
            {profile.abvComfortRange.min}% - {profile.abvComfortRange.max}%
            <span style={{ fontSize: 12, marginLeft: 8, color: "#8b949e", fontWeight: 400 }}>
              ({profile.abvComfortRange.evidenceCount}条记录)
            </span>
          </div>
        ) : (
          <div style={{ color: "#484f58", fontSize: 12 }}>暂无</div>
        )}
      </div>
    </div>
  );
}

function ReflectionTracePanel() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    fetch("/api/memory-trace?type=reflection&userId=local-user")
      .then((r) => r.json()).then(setData).catch(() => {});
  }, []);

  const reflections = data?.reflections || [];
  return (
    <div>
      <div style={{ marginBottom: 12, fontSize: 13, color: "#8b949e" }}>
        画像复核历史 ({reflections.length} 次)
        <span style={{ marginLeft: 8, fontSize: 11, color: "#484f58" }}>
          流程: 读取画像 → LLM 反思 → 标记可疑标签 → 清理
        </span>
      </div>
      {reflections.length === 0 && (
        <div style={{ color: "#484f58", padding: 20, textAlign: "center" }}>
          暂无复核记录。画像复核在 tasting_feedback 触发后自动执行。
        </div>
      )}
      {reflections.map((r: any, i: number) => (
        <div key={i} style={{ padding: "12px 14px", marginBottom: 8, background: "#161b22", borderRadius: 6, border: "1px solid #30363d" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: "#c9d1d9" }}>
              复核 #{reflections.length - i} · {r.reflectedAt?.slice(0, 19) || "?"}
            </span>
            <span style={{ fontSize: 11, color: "#8b949e" }}>
              标签: {r.originalTagCount} → {r.cleanedTagCount}
            </span>
          </div>
          {(r.suspiciousTags || []).map((st: any, j: number) => (
            <div key={j} style={{
              display: "flex", gap: 8, padding: "6px 8px", marginBottom: 4, borderRadius: 4,
              background: st.action === "remove" ? "#2a1a1a" : st.action === "modify" ? "#2a2a1a" : "#0d1117",
              border: "1px solid #30363d", alignItems: "center",
            }}>
              <span style={{
                fontSize: 10, padding: "2px 6px", borderRadius: 3, flexShrink: 0,
                background: st.action === "remove" ? "#3a2020" : st.action === "modify" ? "#3a3020" : "#1a3022",
                color: st.action === "remove" ? "#da3633" : st.action === "modify" ? "#d4a017" : "#3fb950",
              }}>
                {st.action === "remove" ? "删除" : st.action === "modify" ? "修正" : "保留"}
              </span>
              <span style={{ fontSize: 12, color: "#c9d1d9" }}>
                {st.tagName}: <strong>{st.tagValue}</strong>
                {st.suggestedValue && <span style={{ color: "#d4a017" }}> → {st.suggestedValue}</span>}
              </span>
              <span style={{ fontSize: 11, color: "#8b949e", marginLeft: "auto" }}>{st.reason}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function EpisodesTracePanel() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    fetch("/api/memory-trace?type=episodes&userId=local-user")
      .then((r) => r.json()).then(setData).catch(() => {});
  }, []);

  const episodes = data?.episodes || [];
  return (
    <div>
      <div style={{ marginBottom: 12, fontSize: 13, color: "#8b949e" }}>
        品饮记录 ({episodes.length} 条)
      </div>
      {episodes.length === 0 && (
        <div style={{ color: "#484f58", padding: 20, textAlign: "center" }}>暂无品饮记录</div>
      )}
      {episodes.map((ep: any, i: number) => (
        <div key={i} style={{ padding: "10px 14px", marginBottom: 8, background: "#161b22", borderRadius: 6, border: "1px solid #30363d" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#c9d1d9" }}>{ep.beer?.displayName || "未知啤酒"}</span>
            <span style={{ fontSize: 12, color: "#d4a017" }}>⭐ {ep.feedback?.overallScore || "?"}/5</span>
          </div>
          <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>
            {ep.beer?.brewery} · {ep.beer?.style} · {ep.beer?.abv}% ABV
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {ep.feedback?.aromaTags?.map((t: string) => (
              <span key={t} style={{ fontSize: 10, padding: "2px 6px", background: "#1a3022", borderRadius: 99, color: "#7ab89a" }}>👃 {t}</span>
            ))}
            {ep.feedback?.tasteTags?.map((t: string) => (
              <span key={t} style={{ fontSize: 10, padding: "2px 6px", background: "#1a2a36", borderRadius: 99, color: "#8ab4d0" }}>👅 {t}</span>
            ))}
          </div>
          <div style={{ fontSize: 10, color: "#484f58", marginTop: 4 }}>
            {ep.createdAt?.slice(0, 19)} · {ep.feedback?.wouldDrinkAgain === "yes" ? "会再喝" : ep.feedback?.wouldDrinkAgain === "no" ? "不会再喝" : "看情况"}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Benchmark view ──

function BenchmarkView() {
  const [results, setResults] = useState<any>(null);
  const [running, setRunning] = useState(false);

  const runBenchmark = useCallback(async () => {
    setRunning(true);
    try {
      const r = await fetch("/api/benchmark");
      setResults(await r.json());
    } catch {}
    setRunning(false);
  }, []);

  useEffect(() => { runBenchmark(); }, [runBenchmark]);

  const statusColor = (s: string) => s === "pass" ? "#3fb950" : s === "warn" ? "#d4a017" : "#da3633";
  const statusBg = (s: string) => s === "pass" ? "#1a3022" : s === "warn" ? "#2a2a1a" : "#2a1a1a";
  const statusIcon = (s: string) => s === "pass" ? "✅" : s === "warn" ? "⚠️" : "❌";

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 20, background: "#0d1117" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 16, color: "#58a6ff" }}>系统健康检查 (Benchmark)</h3>
        <button onClick={runBenchmark} disabled={running}
          style={{ padding: "8px 20px", background: running ? "#21262d" : "#238636", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
          {running ? "⏳ 运行中..." : "🔄 重新运行"}
        </button>
      </div>

      {results && (
        <>
          <div style={{
            display: "flex", alignItems: "center", gap: 16, padding: 20, marginBottom: 20,
            background: results.healthScore >= 80 ? "#1a3022" : results.healthScore >= 50 ? "#2a2a1a" : "#2a1a1a",
            borderRadius: 12, border: `1px solid ${results.healthScore >= 80 ? "#238636" : results.healthScore >= 50 ? "#d4a017" : "#da3633"}`,
          }}>
            <div style={{
              width: 80, height: 80, borderRadius: "50%",
              background: `conic-gradient(${results.healthScore >= 80 ? "#3fb950" : results.healthScore >= 50 ? "#d4a017" : "#da3633"} ${results.healthScore}%, #21262d 0)`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#0d1117", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 22, fontWeight: 800, color: "#c9d1d9" }}>{results.healthScore}%</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#c9d1d9", marginBottom: 4 }}>{results.summary}</div>
              <div style={{ fontSize: 12, color: "#8b949e" }}>总耗时 {results.totalMs}ms · {results.timestamp ? new Date(results.timestamp).toLocaleTimeString() : ""}</div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginBottom: 20 }}>
            {(results.results || []).map((r: any) => (
              <div key={r.id} style={{
                padding: 14, borderRadius: 8, background: statusBg(r.status),
                border: `1px solid ${statusColor(r.status)}22`,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span>{statusIcon(r.status)}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#c9d1d9" }}>{r.name}</span>
                  </div>
                  <span style={{ fontSize: 11, color: "#8b949e" }}>{r.latencyMs}ms</span>
                </div>
                <div style={{ fontSize: 11, color: "#8b949e", marginBottom: r.suggestion ? 6 : 0 }}>{r.detail}</div>
                {r.suggestion && (
                  <div style={{ fontSize: 11, color: "#d4a017", background: "#0d1117", padding: "4px 8px", borderRadius: 4 }}>
                    💡 {r.suggestion}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
            <h4 style={{ margin: "0 0 12px", fontSize: 14, color: "#c9d1d9" }}>节点级监控</h4>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {["openrouter", "vision-pipeline", "intent-classifier", "beer-db", "memory", "intent-registry"].map(nodeId => {
                const nodeResults = (results.results || []).filter((r: any) => r.node === nodeId);
                const avgMs = nodeResults.length > 0 ? Math.round(nodeResults.reduce((s: number, r: any) => s + r.latencyMs, 0) / nodeResults.length) : 0;
                const hasFail = nodeResults.some((r: any) => r.status === "fail");
                const hasWarn = nodeResults.some((r: any) => r.status === "warn");
                return (
                  <div key={nodeId} style={{ padding: "10px 12px", borderRadius: 6, background: "#0d1117", border: `1px solid ${hasFail ? "#3a2020" : hasWarn ? "#3a3020" : "#21262d"}` }}>
                    <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>{nodeId}</div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: hasFail ? "#da3633" : hasWarn ? "#d4a017" : "#3fb950" }}>
                        {hasFail ? "异常" : hasWarn ? "警告" : "正常"}
                      </span>
                      <span style={{ fontSize: 11, color: "#8b949e" }}>{avgMs}ms</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {!results && !running && (
        <div style={{ color: "#484f58", textAlign: "center", padding: 40 }}>正在加载...</div>
      )}
    </div>
  );
}

function CaseView({ onNavigateToRawData }: { onNavigateToRawData?: () => void }) {
  const [cases, setCases] = useState<any[]>([]);
  const [filter, setFilter] = useState({ status: "", label: "", search: "" });
  const [selected, setSelected] = useState<any>(null);
  const [trace, setTrace] = useState<any>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [timelineTab, setTimelineTab] = useState<"timeline" | "raw">("timeline");

  const LABELS = ["good", "intent_wrong","ocr_wrong","recommendation_bad","hallucination","memory_wrong","data_missing","response_bad"];
  const ROOT_CAUSES = [
    { value: "ocr", label: "OCR 识别", desc: "图片文字提取错误" },
    { value: "intent", label: "意图识别", desc: "意图分类错误" },
    { value: "beer_db", label: "啤酒数据库", desc: "数据缺失或错误" },
    { value: "recommendation", label: "推荐算法", desc: "推荐排序不合理" },
    { value: "prompt", label: "Prompt", desc: "提示词设计问题" },
    { value: "model", label: "模型", desc: "LLM 模型能力不足/模型错误" },
    { value: "memory", label: "记忆", desc: "短期/长期记忆问题" },
    { value: "guardrail", label: "护栏", desc: "后置规则误判" },
    { value: "planner", label: "Planner", desc: "计划生成/执行问题" },
    { value: "tool_route", label: "工具路由", desc: "工具选择/调用错误" },
    { value: "unknown", label: "未知", desc: "暂不确定根因" },
  ];

  const fetchCases = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter.status) params.set("status", filter.status);
    if (filter.label) params.set("label", filter.label);
    if (filter.search) params.set("search", filter.search);
    const res = await fetch(`/api/cases?${params}`);
    setCases(await res.json());
  }, [filter]);

  useEffect(() => { fetchCases(); }, [fetchCases]);

  const saveDetail = async (id: string, updates: any) => {
    await fetch(`/api/cases/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates) });
    if (selected?.id === id) setSelected({ ...selected, ...updates });
    fetchCases();
  };

  const openDetail = async (c: any) => {
    setSelected(c);
    setTrace(null);
    setTraceLoading(true);
    setTimelineTab("timeline");
    try {
      const r = await fetch(`/api/cases/${c.id}`);
      if (r.ok) setTrace((await r.json()).trace);
    } catch {}
    setTraceLoading(false);
  };

  const labelColor = (label: string | null) => {
    if (!label) return "#484f58";
    if (label === "good") return "#238636";
    return "#da3633";
  };

  const labelBg = (label: string | null) => {
    if (!label) return "#21262d";
    if (label === "good") return "#1a3022";
    return "#2a1a1a";
  };

  const statusColor = (status: string) => {
    switch (status) {
      case "fixed": return "#3fb950";
      case "reviewed": return "#58a6ff";
      case "ignored": return "#8b949e";
      default: return "#d4a017";
    }
  };

  const rootCauseColor = (rc: string | undefined) => {
    const map: Record<string, string> = {
      ocr: "#e17055", intent: "#00b894", beer_db: "#00cec9",
      recommendation: "#fdcb6e", prompt: "#a29bfe", model: "#0984e3",
      memory: "#6c5ce7", guardrail: "#ff6b6b", planner: "#d4a017",
      tool_route: "#e05555",
    };
    return rc ? (map[rc] || "#636e72") : "#484f58";
  };

  const badcaseCount = cases.filter(c => c.label && c.label !== "good").length;

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {/* ── Left sidebar: case list ── */}
      <div style={{ width: 400, borderRight: "1px solid #30363d", overflow: "auto", padding: 16, display: "flex", flexDirection: "column" }}>
        {/* Header */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h3 style={{ margin: 0, fontSize: 14, color: "#58a6ff" }}>Badcase 工作台</h3>
            <span style={{ fontSize: 11, color: "#f0883e" }}>{badcaseCount} badcase</span>
          </div>
          {/* Search */}
          <input
            type="text"
            placeholder="搜索用户输入或回复..."
            value={filter.search}
            onChange={e => setFilter(f => ({ ...f, search: e.target.value }))}
            onKeyDown={e => e.key === "Enter" && fetchCases()}
            style={{ width: "100%", padding: "7px 10px", background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12, marginBottom: 8, boxSizing: "border-box" }}
          />
          {/* Filters */}
          <div style={{ display: "flex", gap: 6 }}>
            <select value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}
              style={{ flex: 1, padding: 6, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 11 }}>
              <option value="">All Status</option>
              <option value="unlabeled">Unlabeled</option>
              <option value="reviewed">Reviewed</option>
              <option value="fixed">Fixed</option>
              <option value="ignored">Ignored</option>
            </select>
            <select value={filter.label} onChange={e => setFilter(f => ({ ...f, label: e.target.value }))}
              style={{ flex: 1, padding: 6, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 11 }}>
              <option value="">All Labels</option>
              {LABELS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
        </div>

        <button onClick={fetchCases}
          style={{ width: "100%", padding: 6, marginBottom: 10, background: "#21262d", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>
          🔄 刷新 ({cases.length} cases)
        </button>

        {/* Case list */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {cases.map(c => (
            <div key={c.id} onClick={() => openDetail(c)}
              style={{
                padding: "10px 12px", marginBottom: 6, cursor: "pointer", borderRadius: 6,
                background: selected?.id === c.id ? "#161b22" : "#0d1117",
                border: selected?.id === c.id ? "1px solid #58a6ff" : "1px solid #21262d",
                transition: "border-color 0.15s",
              }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: "#c9d1d9", fontWeight: 500, flex: 1, marginRight: 8 }}>
                  {c.input.text.slice(0, 50)}{c.input.hasImage ? " 🖼" : ""}
                  {c.input.hasImage && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        onNavigateToRawData?.();
                      }}
                      style={{
                        marginLeft: 4, fontSize: 9, padding: "1px 5px", borderRadius: 3,
                        background: "#58a6ff22", color: "#58a6ff", cursor: "pointer",
                        border: "1px solid #58a6ff44",
                      }}
                      title="去原数据标注页面">VQA</span>
                  )}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ color: "#8b949e" }}>{c.intent.name}</span>
                  <span style={{ color: "#d4a017" }}>{(c.intent.confidence * 100).toFixed(0)}%</span>
                  {c.candidateCount > 0 && <span style={{ color: "#484f58" }}>{c.candidateCount}cand</span>}
                </div>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  {c.rootCause && (
                    <span style={{ padding: "1px 5px", borderRadius: 3, background: rootCauseColor(c.rootCause) + "33", color: rootCauseColor(c.rootCause), fontSize: 9 }}>
                      {ROOT_CAUSES.find(rc => rc.value === c.rootCause)?.label || c.rootCause}
                    </span>
                  )}
                  <span style={{ padding: "1px 6px", borderRadius: 3, background: labelBg(c.label), color: labelColor(c.label) || "#8b949e", fontSize: 9, whiteSpace: "nowrap" }}>
                    {c.label || "unlabeled"}
                  </span>
                </div>
              </div>
              {c.warnings?.length > 0 && (
                <div style={{ fontSize: 9, color: "#f0883e", marginTop: 3 }}>⚠ {c.warnings.length} warnings</div>
              )}
              <div style={{ fontSize: 9, color: "#484f58", marginTop: 2 }}>
                {c.createdAt ? new Date(c.createdAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
              </div>
            </div>
          ))}
          {cases.length === 0 && (
            <div style={{ color: "#484f58", textAlign: "center", marginTop: 40, fontSize: 12 }}>
              没有匹配的 case
            </div>
          )}
        </div>
      </div>

      {/* ── Right: case detail + trace ── */}
      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {!selected && (
          <div style={{ color: "#484f58", marginTop: 80, textAlign: "center", fontSize: 13 }}>
            👈 从左侧选择 case 开始诊断
          </div>
        )}

        {selected && (
          <>
            {/* ── Top bar: label + status ── */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
              <div style={{ flex: 1, marginRight: 16 }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 15, color: "#c9d1d9" }}>
                  {selected.input.text}{selected.input.hasImage ? " 🖼" : ""}
                </h3>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", fontSize: 11, color: "#8b949e" }}>
                  <span>Intent: <strong style={{ color: "#58a6ff" }}>{selected.intent.name}</strong> ({(selected.intent.confidence * 100).toFixed(0)}%)</span>
                  <span>·</span>
                  <span>{selected.candidateCount} candidates</span>
                  {selected.input.hasImage && <><span>·</span><span>🖼 {selected.input.imageName || "image"}</span></>}
                  <span>·</span>
                  <span>{selected.createdAt ? new Date(selected.createdAt).toLocaleString("zh-CN") : ""}</span>
                </div>
              </div>
              {/* Status selector */}
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 4 }}>Status</div>
                <select
                  value={selected.status || "unlabeled"}
                  onChange={e => saveDetail(selected.id, { status: e.target.value })}
                  style={{ padding: "4px 8px", background: "#161b22", color: statusColor(selected.status), border: `1px solid ${statusColor(selected.status)}33`, borderRadius: 4, fontSize: 11 }}>
                  <option value="unlabeled">unlabeled</option>
                  <option value="reviewed">reviewed</option>
                  <option value="fixed">fixed</option>
                  <option value="ignored">ignored</option>
                </select>
              </div>
            </div>

            {/* ── Reply preview ── */}
            <div style={{ padding: 12, background: "#161b22", borderRadius: 6, border: "1px solid #30363d", marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 6 }}>🤖 回复预览</div>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#c9d1d9", margin: 0, lineHeight: 1.5 }}>{selected.replyPreview}</pre>
            </div>

            {/* ── Warnings ── */}
            {selected.warnings?.length > 0 && (
              <div style={{ padding: 12, background: "#da363310", borderRadius: 6, border: "1px solid #da363344", marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: "#da3633", marginBottom: 6, fontWeight: 600 }}>⚠ Warnings ({selected.warnings.length})</div>
                {selected.warnings.map((w: string, i: number) => (
                  <div key={i} style={{ fontSize: 11, color: "#f0883e", padding: "2px 0" }}>{w}</div>
                ))}
              </div>
            )}

            {/* ── Label buttons ── */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 6 }}>🏷 Label</div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {LABELS.map(l => (
                  <button key={l} onClick={() => saveDetail(selected.id, { label: l })}
                    style={{
                      padding: "4px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer",
                      background: selected.label === l ? labelColor(l) : "#21262d",
                      color: selected.label === l ? "#fff" : "#8b949e",
                      border: selected.label === l ? `1px solid ${labelColor(l)}` : "1px solid #30363d",
                      fontWeight: selected.label === l ? 600 : 400,
                    }}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Root cause ── */}
            <div style={{ marginBottom: 14, padding: 12, background: "#161b22", borderRadius: 6, border: "1px solid #30363d" }}>
              <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 8 }}>🔍 根因分析 (rootCause)</div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                <button
                  onClick={() => saveDetail(selected.id, { rootCause: undefined })}
                  style={{
                    padding: "4px 10px", fontSize: 10, borderRadius: 4, cursor: "pointer",
                    background: !selected.rootCause ? "#484f58" : "#21262d",
                    color: !selected.rootCause ? "#fff" : "#484f58",
                    border: "1px solid #30363d",
                  }}>
                  (未分类)
                </button>
                {ROOT_CAUSES.map(rc => (
                  <button key={rc.value}
                    onClick={() => saveDetail(selected.id, { rootCause: rc.value })}
                    title={rc.desc}
                    style={{
                      padding: "4px 10px", fontSize: 10, borderRadius: 4, cursor: "pointer",
                      background: selected.rootCause === rc.value ? rootCauseColor(rc.value) : "#21262d",
                      color: selected.rootCause === rc.value ? "#fff" : "#8b949e",
                      border: selected.rootCause === rc.value ? `1px solid ${rootCauseColor(rc.value)}` : "1px solid #30363d",
                      fontWeight: selected.rootCause === rc.value ? 600 : 400,
                    }}>
                    {rc.label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Note ── */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>📝 分析备注</div>
              <textarea
                placeholder="为什么判定这个 badcase？哪个环节出了问题？"
                value={selected.note || ""}
                onChange={e => setSelected({ ...selected, note: e.target.value })}
                onBlur={() => saveDetail(selected.id, { note: selected.note || "" })}
                style={{ width: "100%", minHeight: 70, padding: 8, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 6, fontSize: 12, resize: "vertical", fontFamily: "system-ui", boxSizing: "border-box" }}
              />
            </div>

            {/* ── Expected intent + reply ── */}
            <div style={{ marginBottom: 14, padding: 12, background: "#161b22", borderRadius: 6, border: "1px solid #30363d" }}>
              <div style={{ fontSize: 11, color: "#58a6ff", marginBottom: 8, fontWeight: 600 }}>✅ 期望行为 (Expected)</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 3 }}>期望意图</div>
                  <select
                    value={selected.expected?.intent || ""}
                    onChange={e => saveDetail(selected.id, { expected: { ...selected.expected, intent: e.target.value || undefined } })}
                    style={{ width: "100%", padding: 6, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 11 }}>
                    <option value="">(未设置)</option>
                    {["menu_recommend","follow_up_filter","tasting_feedback","profile_query","beer_knowledge","label_check","memory_correction","unclear"].map(i => <option key={i} value={i}>{i}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 3 }}>期望酒名</div>
                  <input
                    placeholder="(未设置)"
                    value={selected.expected?.beerName || ""}
                    onChange={e => saveDetail(selected.id, { expected: { ...selected.expected, beerName: e.target.value || undefined } })}
                    style={{ width: "100%", padding: 6, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 11, boxSizing: "border-box" }}
                  />
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 3 }}>期望回复</div>
                <textarea
                  placeholder="(未设置) 你认为正确的回复应该什么样？"
                  value={selected.expected?.reply || ""}
                  onChange={e => setSelected({ ...selected, expected: { ...selected.expected, reply: e.target.value } })}
                  onBlur={() => saveDetail(selected.id, { expected: selected.expected })}
                  style={{ width: "100%", minHeight: 50, padding: 8, background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 11, resize: "vertical", fontFamily: "system-ui", boxSizing: "border-box" }}
                />
              </div>
            </div>

            {/* ── Trace section ── */}
            <div style={{ marginBottom: 12 }}>
              {!trace && !traceLoading && (
                <div style={{ padding: 16, background: "#161b22", borderRadius: 6, border: "1px solid #30363d", textAlign: "center" }}>
                  <span style={{ fontSize: 12, color: "#8b949e" }}>
                    traceId: <code style={{ color: "#58a6ff", fontSize: 11 }}>{selected.traceId}</code>
                  </span>
                  <br />
                  <button onClick={() => openDetail(selected)}
                    style={{ marginTop: 8, padding: "4px 12px", background: "#21262d", color: "#58a6ff", border: "1px solid #30363d", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>
                    加载 Trace
                  </button>
                </div>
              )}
              {traceLoading && (
                <div style={{ padding: 16, textAlign: "center", color: "#8b949e", fontSize: 12 }}>加载 trace 中...</div>
              )}
              {trace && (
                <div style={{ background: "#161b22", borderRadius: 8, border: "1px solid #30363d", overflow: "hidden" }}>
                  {/* Trace header */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid #30363d" }}>
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#58a6ff" }}>📋 Trace 详情</span>
                      <code style={{ marginLeft: 8, fontSize: 10, color: "#8b949e" }}>{selected.traceId}</code>
                    </div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => setTimelineTab("timeline")}
                        style={{ padding: "4px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer",
                          background: timelineTab === "timeline" ? "#58a6ff22" : "transparent",
                          color: timelineTab === "timeline" ? "#58a6ff" : "#8b949e",
                          border: timelineTab === "timeline" ? "1px solid #58a6ff44" : "1px solid transparent" }}>
                        时间线
                      </button>
                      <button onClick={() => setTimelineTab("raw")}
                        style={{ padding: "4px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer",
                          background: timelineTab === "raw" ? "#58a6ff22" : "transparent",
                          color: timelineTab === "raw" ? "#58a6ff" : "#8b949e",
                          border: timelineTab === "raw" ? "1px solid #58a6ff44" : "1px solid transparent" }}>
                        Raw JSON
                      </button>
                    </div>
                  </div>

                  {timelineTab === "raw" ? (
                    <pre style={{ margin: 0, padding: 16, fontSize: 10, whiteSpace: "pre-wrap", color: "#c9d1d9", maxHeight: 400, overflow: "auto", lineHeight: 1.4 }}>
                      {JSON.stringify(trace, null, 2)}
                    </pre>
                  ) : (
                    <div style={{ maxHeight: 500, overflow: "auto", padding: 16 }}>
                      <TraceTimeline trace={trace} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Trace Timeline component ──

function TraceTimeline({ trace }: { trace: any }) {
  const steps: Array<{ icon: string; label: string; color: string; content: any; render: (v: any) => ReactNode }> = [];

  // 1. Input
  if (trace.input) {
    steps.push({
      icon: "📥", label: "Input", color: "#6c5ce7",
      content: trace.input,
      render: (v: any) => (
        <div style={{ fontSize: 12, color: "#c9d1d9", lineHeight: 1.6 }}>
          <div><span style={{ color: "#8b949e" }}>用户输入：</span>"{v.lastUserText}"</div>
          <div style={{ display: "flex", gap: 12, marginTop: 4, fontSize: 11 }}>
            <span style={{ color: "#8b949e" }}>有图片：{v.hasImage ? "✅ 是" : "❌ 否"}</span>
            {v.imageName && <span style={{ color: "#8b949e" }}>图片：{v.imageName}</span>}
            <span style={{ color: "#8b949e" }}>消息数：{v.messageCount}</span>
          </div>
        </div>
      ),
    });
  }

  // 2. Intent Result
  if (trace.intentResult) {
    const ir = trace.intentResult;
    steps.push({
      icon: "🎯", label: "Intent Result", color: "#00b894",
      content: ir,
      render: (v: any) => (
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontWeight: 600, color: "#58a6ff", fontSize: 14 }}>{ir.intent}</span>
            <span style={{
              padding: "2px 8px", borderRadius: 99, fontSize: 11,
              background: ir.source === "rule" ? "#1a3022" : ir.source === "llm" ? "#1a2a3a" : "#2a1a1a",
              color: ir.source === "rule" ? "#3fb950" : ir.source === "llm" ? "#58a6ff" : "#da3633",
            }}>
              {ir.source === "rule" ? "规则匹配" : ir.source === "llm" ? "LLM 识别" : "兜底"}
            </span>
            <span style={{ color: "#d4a017", fontWeight: 600 }}>{(ir.confidence * 100).toFixed(0)}%</span>
            {ir.isMultiIntent && <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 3, background: "#f0883e22", color: "#f0883e" }}>多意图</span>}
          </div>
          {ir.intents?.length > 1 && (
            <div style={{ marginTop: 4 }}>
              {ir.intents.map((item: any, i: number) => (
                <div key={i} style={{ display: "flex", gap: 8, fontSize: 11, padding: "3px 0", color: i === 0 ? "#c9d1d9" : "#8b949e" }}>
                  <span>{i === 0 ? "★" : "·"}</span>
                  <span>{item.intent}</span>
                  <span style={{ color: "#d4a017" }}>{(item.confidence * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
          {ir.routeReason && <div style={{ fontSize: 10, color: "#484f58", marginTop: 4 }}>路由原因：{ir.routeReason}</div>}
        </div>
      ),
    });
  }

  // 3. Memory Snapshot
  if (trace.memorySnapshot) {
    const ms = trace.memorySnapshot;
    steps.push({
      icon: "🧠", label: "Memory Snapshot", color: "#0984e3",
      content: ms,
      render: (v: any) => (
        <div style={{ fontSize: 11, lineHeight: 1.6 }}>
          {v.shortTerm ? (
            <div style={{ marginBottom: 4 }}>
              <span style={{ color: "#8b949e" }}>短期记忆：</span>
              {v.shortTerm.lastMenuCandidateCount !== undefined && (
                <span style={{ color: "#c9d1d9" }}>候选 {v.shortTerm.lastMenuCandidateCount} 款</span>
              )}
              {v.shortTerm.hasLastRecommendation !== undefined && (
                <span style={{ marginLeft: 8, color: "#c9d1d9" }}>
                  {v.shortTerm.hasLastRecommendation ? "· 有上轮推荐" : "· 无上轮推荐"}
                </span>
              )}
              {v.shortTerm.activeBeerName !== undefined && (
                <span style={{ marginLeft: 8, color: "#c9d1d9" }}>
                  · 活跃酒: {v.shortTerm.activeBeerName || "无"}
                </span>
              )}
            </div>
          ) : (
            <div style={{ color: "#484f58" }}>无短期记忆</div>
          )}
          {v.profileSummary && (
            <div style={{ color: "#8b949e", fontSize: 10, marginTop: 4 }}>
              画像摘要: <span style={{ color: "#c9d1d9" }}>{v.profileSummary.slice(0, 80)}{v.profileSummary.length > 80 ? "..." : ""}</span>
            </div>
          )}
        </div>
      ),
    });
  }

  // 4. Output
  if (trace.output) {
    const out = trace.output;
    steps.push({
      icon: "📤", label: "Output", color: "#e17055",
      content: out,
      render: (v: any) => (
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          <div style={{ color: "#c9d1d9", marginBottom: 4 }}>
            <span style={{ color: "#8b949e" }}>回复：</span>
            <span style={{ whiteSpace: "pre-wrap" }}>{v.reply?.slice(0, 200)}{v.reply?.length > 200 ? "..." : ""}</span>
          </div>
          <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
            <span style={{ color: "#8b949e" }}>候选数：{v.candidateCount}</span>
            <span style={{ color: "#8b949e" }}>模式：{v.mode}</span>
            {v.overallRating && <span style={{ color: "#8b949e" }}>总体评分：{v.overallRating}</span>}
          </div>
        </div>
      ),
    });
  }

  // 5. Model Info (from debug.modelNames)
  if (trace.debug?.modelNames && Object.keys(trace.debug.modelNames).length > 0) {
    const mn = trace.debug.modelNames;
    steps.push({
      icon: "🤖", label: "Active Models", color: "#0984e3",
      content: mn,
      render: (v: Record<string, string>) => (
        <div style={{ fontSize: 11, lineHeight: 1.6 }}>
          {Object.entries(v).map(([kind, model]) => (
            <div key={kind} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
              <span style={{ color: "#8b949e", width: 70 }}>
                {kind === "vision" ? "👁 Vision" : kind === "analysis" ? "🧠 Analysis" : kind === "chat" ? "💬 Chat" : kind}
              </span>
              <code style={{ color: "#c9d1d9" }}>{model}</code>
            </div>
          ))}
        </div>
      ),
    });
  }

  // 6. Debug Warnings
  if (trace.debug?.warnings?.length > 0) {
    steps.push({
      icon: "⚠️", label: "Debug Warnings", color: "#da3633",
      content: trace.debug.warnings,
      render: (v: string[]) => (
        <div style={{ fontSize: 11, lineHeight: 1.6 }}>
          {v.map((w: string, i: number) => (
            <div key={i} style={{ color: "#f0883e", padding: "2px 0" }}>⚠ {w}</div>
          ))}
        </div>
      ),
    });
  }

  // 6. Memory Delta
  if (trace.memoryDelta) {
    const md = trace.memoryDelta;
    steps.push({
      icon: "📝", label: "Memory Delta", color: "#6c5ce7",
      content: md,
      render: (v: any) => (
        <div style={{ fontSize: 11, lineHeight: 1.6 }}>
          <div style={{ display: "flex", gap: 10 }}>
            <span style={{ color: v.wroteShortTerm ? "#3fb950" : "#484f58" }}>
              {v.wroteShortTerm ? "✅" : "○"} 短期记忆
            </span>
            <span style={{ color: v.wroteEpisodic ? "#3fb950" : "#484f58" }}>
              {v.wroteEpisodic ? "✅" : "○"} 品饮记录
            </span>
            <span style={{ color: v.updatedProfile ? "#3fb950" : "#484f58" }}>
              {v.updatedProfile ? "✅" : "○"} 画像更新
            </span>
          </div>
          {v.notes?.length > 0 && (
            <div style={{ marginTop: 4 }}>
              {v.notes.map((n: string, i: number) => (
                <div key={i} style={{ fontSize: 10, color: "#8b949e" }}>· {n}</div>
              ))}
            </div>
          )}
        </div>
      ),
    });
  }

  // 7. Route
  if (trace.route) {
    steps.push({
      icon: "🔀", label: "Route", color: "#fdcb6e",
      content: trace.route,
      render: (v: any) => (
        <div style={{ fontSize: 11, lineHeight: 1.6 }}>
          <span style={{ color: "#8b949e" }}>Handler: </span>
          <span style={{ color: "#c9d1d9", fontWeight: 600 }}>{v.handler}</span>
          {v.usedLegacyAgent && <span style={{ marginLeft: 8, color: "#d4a017" }}>Legacy: {v.usedLegacyAgent}</span>}
        </div>
      ),
    });
  }

  // 8. Errors
  if (trace.errors?.length > 0) {
    steps.push({
      icon: "❌", label: "Errors", color: "#da3633",
      content: trace.errors,
      render: (v: any[]) => (
        <div style={{ fontSize: 11, lineHeight: 1.6 }}>
          {v.map((e: any, i: number) => (
            <div key={i} style={{ marginBottom: 4, padding: 6, background: "#2a1a1a", borderRadius: 4 }}>
              <div style={{ color: "#da3633" }}>{e.message}</div>
              {e.model && (
                <div style={{ display: "flex", gap: 6, marginTop: 3, fontSize: 10 }}>
                  {e.provider && <span style={{ color: "#f0883e" }}>provider: {e.provider}</span>}
                  <span style={{ color: "#f0883e" }}>model: {e.model}</span>
                  {e.errorCode && <span style={{ color: "#da3633" }}>code: {e.errorCode}</span>}
                </div>
              )}
              {e.stack && <div style={{ fontSize: 9, color: "#484f58", whiteSpace: "pre-wrap", marginTop: 2 }}>{e.stack.slice(0, 200)}</div>}
            </div>
          ))}
        </div>
      ),
    });
  }

  return (
    <div style={{ position: "relative", paddingLeft: 24 }}>
      {/* Vertical line */}
      <div style={{ position: "absolute", left: 8, top: 8, bottom: 8, width: 2, background: "#30363d" }} />

      {steps.map((step, i) => (
        <div key={i} style={{ position: "relative", marginBottom: i < steps.length - 1 ? 16 : 0 }}>
          {/* Dot on the line */}
          <div style={{
            position: "absolute", left: -18, top: 4,
            width: 10, height: 10, borderRadius: "50%",
            background: step.color, border: "2px solid #0d1117",
            zIndex: 1,
          }} />
          {/* Content */}
          <div style={{
            padding: "10px 14px", borderRadius: 6,
            background: "#0d1117", border: `1px solid ${step.color}22`,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span>{step.icon}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: step.color }}>{step.label}</span>
            </div>
            {step.render(step.content)}
          </div>
        </div>
      ))}

      {steps.length === 0 && (
        <div style={{ color: "#484f58", textAlign: "center", padding: 20, fontSize: 12 }}>
          Trace 数据为空
        </div>
      )}
    </div>
  );
}


// ── Prompt & Models View ──

type PromptConfig = { id: string; name: string; content: string; version: number; updatedAt: string; note: string };
type ModelConfig = { provider: string; model: string; temperature: number; maxTokens: number; timeoutMs: number };
type ToolConfig = { id: string; name: string; enabled: boolean; timeoutMs: number; retry: number; notes: string };

const PROMPT_IDS = [
  { id: "vision_ocr", label: "Vision OCR", desc: "图片分类+OCR+质量检查三合一" },
  { id: "intent_classify", label: "意图分类", desc: "LLM fallback 时的意图识别 prompt" },
  { id: "beer_knowledge", label: "啤酒知识", desc: "纯 LLM 知识问答 system prompt" },
  { id: "recommendation_reply", label: "推荐回复", desc: "推荐引擎 system prompt" },
  { id: "guardrail", label: "护栏规则", desc: "后置护栏规则描述" },
  { id: "memory_extract", label: "记忆提取", desc: "对话信息提取 prompt" },
];

const MODEL_IDS = [
  { id: "vision", label: "Vision 视觉", desc: "Gemini Flash 视觉分析" },
  { id: "analysis", label: "Analysis 分析", desc: "推荐/知识问答" },
  { id: "chat", label: "Chat 对话", desc: "通用对话" },
  { id: "intent", label: "Intent 意图", desc: "意图识别 LLM fallback" },
  { id: "embedding", label: "Embedding 向量", desc: "语义相似度匹配" },
];

const TOOL_IDS = [
  { id: "vision_pipeline", label: "视觉流水线", desc: "图片分类+OCR+质量检查" },
  { id: "beer_db_lookup", label: "啤酒数据库", desc: "SQLite+Untappd 查询" },
  { id: "recommendation_scoring", label: "推荐评分", desc: "worthScore+fitScore" },
  { id: "memory_profile", label: "记忆画像", desc: "短期记忆+品饮+画像" },
  { id: "guardrails", label: "后置护栏", desc: "5条规则检查+拦截" },
];

const PROVIDERS = ["openrouter", "openai", "anthropic", "google"];

function PromptModelsView() {
  const [tab, setTab] = useState<"prompts" | "models" | "tools">("prompts");
  const [config, setConfig] = useState<Record<string, any>>({});
  const [selectedPrompt, setSelectedPrompt] = useState<string>("vision_ocr");
  const [selectedModel, setSelectedModel] = useState<string>("vision");
  const [selectedTool, setSelectedTool] = useState<string>("vision_pipeline");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [validation, setValidation] = useState<any>(null);
  const [validating, setValidating] = useState(false);

  // Load config
  useEffect(() => {
    fetch("/api/debug-config")
      .then(r => r.json().catch(() => ({})))
      .then(d => { setConfig(d || {}); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const runValidation = async () => {
    setValidating(true);
    try {
      const r = await fetch("/api/debug-config?validate=true");
      setValidation(await r.json());
    } catch {}
    setValidating(false);
  };

  const save = async (updated: Record<string, any>) => {
    setConfig(updated);
    setSaved(true);
    await fetch("/api/debug-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    setTimeout(() => setSaved(false), 2000);
  };

  // ── Prompt helpers ──
  const prompts = (config.prompts || {}) as Record<string, PromptConfig>;
  const getPrompt = (id: string): PromptConfig => prompts[id] ?? { id, name: id, content: "", version: 1, updatedAt: "", note: "" };

  const updatePrompt = (id: string, updates: Partial<PromptConfig>) => {
    const current = getPrompt(id);
    const updated = { ...current, ...updates, updatedAt: new Date().toISOString() };
    save({ ...config, prompts: { ...prompts, [id]: updated } });
  };

  const bumpPromptVersion = (id: string) => {
    const current = getPrompt(id);
    updatePrompt(id, { version: (current.version || 1) + 1 });
  };

  // ── Model helpers ──
  const models = (config.models || {}) as Record<string, ModelConfig | string>;
  const getModel = (id: string): ModelConfig => {
    const m = models[id];
    if (m && typeof m === "object" && (m as ModelConfig).model) return m as ModelConfig;
    if (typeof m === "string") return { provider: "openrouter", model: m, temperature: 0.3, maxTokens: 1500, timeoutMs: 20000 };
    const defs: Record<string, ModelConfig> = {
      vision:    { provider: "openrouter", model: "google/gemini-2.5-flash", temperature: 0.1, maxTokens: 12000, timeoutMs: 30000 },
      analysis:  { provider: "openrouter", model: "openai/gpt-4o-mini",    temperature: 0.3, maxTokens: 1500,  timeoutMs: 20000 },
      chat:      { provider: "openrouter", model: "openai/gpt-4o-mini",    temperature: 0.3, maxTokens: 1500,  timeoutMs: 20000 },
      intent:    { provider: "openrouter", model: "openai/gpt-4o-mini",    temperature: 0,   maxTokens: 300,   timeoutMs: 10000 },
      embedding: { provider: "openai",     model: "text-embedding-3-small", temperature: 0,   maxTokens: 512,   timeoutMs: 10000 },
    };
    return defs[id];
  };

  const updateModel = (id: string, updates: Partial<ModelConfig>) => {
    const current = getModel(id);
    const updated = { ...current, ...updates };
    save({ ...config, models: { ...models, [id]: updated } });
  };

  // ── Tool helpers ──
  const tools = (config.tools || {}) as Record<string, ToolConfig>;
  const getTool = (id: string): ToolConfig => tools[id] ?? { id, name: id, enabled: true, timeoutMs: 10000, retry: 1, notes: "" };

  const updateTool = (id: string, updates: Partial<ToolConfig>) => {
    const current = getTool(id);
    const updated = { ...current, ...updates };
    save({ ...config, tools: { ...tools, [id]: updated } });
  };

  if (loading) {
    return <div style={{ flex: 1, padding: 20, color: "#484f58" }}>加载配置中...</div>;
  }

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {/* Left sidebar: sub-tabs */}
      <div style={{ width: 200, borderRight: "1px solid #30363d", padding: 12, background: "#0d1117", display: "flex", flexDirection: "column" }}>
        <button onClick={() => setTab("prompts")} style={subTabStyle(tab === "prompts")}>📝 Prompts</button>
        <button onClick={() => setTab("models")} style={subTabStyle(tab === "models")}>🤖 Models</button>
        <button onClick={() => setTab("tools")} style={subTabStyle(tab === "tools")}>🔧 Tools</button>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, overflow: "auto", padding: 20, background: "#0d1117" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, color: "#58a6ff" }}>
            {tab === "prompts" ? "Prompt 管理" : tab === "models" ? "模型配置" : "工具配置"}
          </h3>
          {saved && <span style={{ fontSize: 12, color: "#3fb950" }}>✅ 已保存</span>}
        </div>

        {/* Active model info panel — always visible */}
        <div style={{
          display: "flex", gap: 12, marginBottom: 16, padding: 12,
          background: "#161b22", borderRadius: 8, border: "1px solid #30363d",
        }}>
          {(["vision", "intent", "analysis"] as const).map((kind) => {
            const m = getModel(kind);
            return (
              <div key={kind} style={{ flex: 1, padding: "0 8px", borderRight: kind === "analysis" ? "none" : "1px solid #30363d" }}>
                <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 2 }}>
                  {kind === "vision" ? "👁 Vision" : kind === "intent" ? "🎯 Intent" : "🧠 Analysis"}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#c9d1d9" }}>
                  {m.model?.split("/").pop() || "未配置"}
                </div>
                <div style={{ fontSize: 10, color: "#484f58", display: "flex", gap: 6 }}>
                  <span>{m.provider || "openrouter"}</span>
                  <span>·</span>
                  <span>T: {m.temperature ?? "—"}</span>
                  <span>·</span>
                  <span>{m.timeoutMs ?? "—"}ms</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Config validation panel */}
        <div style={{ marginBottom: 16 }}>
          <button onClick={runValidation} disabled={validating}
            style={{
              padding: "4px 12px", fontSize: 11, borderRadius: 4, cursor: "pointer",
              background: "#21262d", color: validation ? (validation.ok ? "#3fb950" : "#da3633") : "#8b949e",
              border: "1px solid #30363d",
            }}>
            {validating ? "⏳ 校验中..." : validation ? (validation.ok ? "✅ 配置校验通过" : "❌ 配置校验发现问题") : "🔍 校验 pipeline-config.json"}
          </button>
          {validation && !validation.ok && validation.issues && (
            <div style={{ marginTop: 8, padding: 8, background: "#2a1a1a", borderRadius: 4, border: "1px solid #da363344" }}>
              {validation.issues.map((issue: string, i: number) => (
                <div key={i} style={{ fontSize: 11, color: "#da3633", padding: "2px 0" }}>• {issue}</div>
              ))}
            </div>
          )}
          {validation && validation.ok && (
            <div style={{ marginTop: 8, fontSize: 10, color: "#484f58" }}>
              JSON 大小: {Math.round((validation.jsonlSize || 0) / 1024)}KB · 校验时间: {validation.lastParsedAt?.slice(0, 19)}
              {validation.info?.routeCount != null && <span> · 路由数: {validation.info.routeCount}</span>}
            </div>
          )}
        </div>

        {tab === "prompts" && (
          <div style={{ display: "flex", gap: 20, height: "calc(100% - 50px)" }}>
            {/* Prompt selector */}
            <div style={{ width: 220, borderRight: "1px solid #21262d", overflow: "auto", paddingRight: 12 }}>
              {(PROMPT_IDS).map(p => {
                const data = getPrompt(p.id);
                const hasContent = data.content && data.content.length > 10;
                return (
                  <div key={p.id}
                    onClick={() => setSelectedPrompt(p.id)}
                    style={{ padding: "8px 10px", marginBottom: 4, borderRadius: 6, cursor: "pointer", background: selectedPrompt === p.id ? "#1a3022" : "transparent", border: selectedPrompt === p.id ? "1px solid #3fb950" : "1px solid transparent", }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#c9d1d9", display: "flex", alignItems: "center", gap: 6 }}>
                      {p.label}
                      {!hasContent && <span style={{ fontSize: 9, padding: "1px 5px", background: "#2a1a1a", color: "#da3633", borderRadius: 3 }}>空</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "#484f58" }}>{p.desc}</div>
                  </div>
                );
              })}
            </div>

            {/* Prompt editor */}
            <div style={{ flex: 1 }}>
              {(() => {
                const p = getPrompt(selectedPrompt);
                const def = PROMPT_IDS.find(d => d.id === selectedPrompt);
                return (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#c9d1d9" }}>{def?.label || selectedPrompt}</span>
                      <code style={{ fontSize: 10, padding: "2px 6px", background: "#21262d", borderRadius: 3, color: "#8b949e" }}>{selectedPrompt}</code>
                      <span style={{ marginLeft: "auto", fontSize: 11, color: "#484f58" }}>v{p.version || 1}</span>
                      <button onClick={() => bumpPromptVersion(selectedPrompt)}
                        style={{ padding: "3px 10px", background: "#21262d", color: "#8b949e", border: "1px solid #30363d", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>
                        + 版本号
                      </button>
                    </div>

                    <div style={{ marginBottom: 12 }}>
                      <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>版本备注</label>
                      <input type="text" value={p.note || ""}
                        onChange={e => updatePrompt(selectedPrompt, { note: e.target.value })}
                        placeholder="记录本次修改原因..."
                        style={{ width: "100%", padding: 6, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12 }} />
                    </div>

                    <div style={{ marginBottom: 12 }}>
                      <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>
                        Prompt 内容
                        <span style={{ marginLeft: 8, fontSize: 10, color: "#484f58" }}>支持 {"{variable}"} 占位符</span>
                      </label>
                      <textarea value={p.content || ""}
                        onChange={e => updatePrompt(selectedPrompt, { content: e.target.value })}
                        rows={22}
                        style={{ width: "100%", padding: 10, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 6, fontSize: 12, resize: "vertical", fontFamily: "monospace", lineHeight: "1.6" }} />
                    </div>

                    <div style={{ fontSize: 10, color: "#484f58" }}>
                      最后更新: {p.updatedAt ? new Date(p.updatedAt).toLocaleString() : "从未保存"}
                      {def && <span style={{ marginLeft: 12 }}>{def.desc}</span>}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {tab === "models" && (
          <div style={{ display: "flex", gap: 20, height: "calc(100% - 50px)" }}>
            {/* Model selector */}
            <div style={{ width: 220, borderRight: "1px solid #21262d", overflow: "auto", paddingRight: 12 }}>
              {MODEL_IDS.map(m => {
                const data = getModel(m.id);
                return (
                  <div key={m.id}
                    onClick={() => setSelectedModel(m.id)}
                    style={{ padding: "8px 10px", marginBottom: 4, borderRadius: 6, cursor: "pointer", background: selectedModel === m.id ? "#1a3022" : "transparent", border: selectedModel === m.id ? "1px solid #3fb950" : "1px solid transparent", }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#c9d1d9" }}>{m.label}</div>
                    <div style={{ fontSize: 11, color: "#8b949e" }}>{data.model}</div>
                    <div style={{ fontSize: 10, color: "#484f58" }}>{m.desc}</div>
                  </div>
                );
              })}
            </div>

            {/* Model editor */}
            <div style={{ flex: 1 }}>
              {(() => {
                const m = getModel(selectedModel);
                const def = MODEL_IDS.find(d => d.id === selectedModel);
                return (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#c9d1d9" }}>{def?.label || selectedModel}</span>
                      <code style={{ fontSize: 10, padding: "2px 6px", background: "#21262d", borderRadius: 3, color: "#8b949e" }}>{selectedModel}</code>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                      <div>
                        <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>Provider</label>
                        <select value={m.provider || "openrouter"}
                          onChange={e => updateModel(selectedModel, { provider: e.target.value })}
                          style={{ width: "100%", padding: 8, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 13 }}>
                          {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>Model 名称</label>
                        <input type="text" value={m.model || ""}
                          onChange={e => updateModel(selectedModel, { model: e.target.value })}
                          placeholder="e.g. openai/gpt-4o"
                          style={{ width: "100%", padding: 8, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 13 }} />
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginTop: 16 }}>
                      <div>
                        <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>
                          Temperature <span style={{ color: "#484f58" }}>({m.temperature})</span>
                        </label>
                        <input type="range" min="0" max="2" step="0.05" value={m.temperature ?? 0.3}
                          onChange={e => updateModel(selectedModel, { temperature: parseFloat(e.target.value) })}
                          style={{ width: "100%" }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>Max Tokens</label>
                        <input type="number" step="100" value={m.maxTokens ?? 1500}
                          onChange={e => updateModel(selectedModel, { maxTokens: parseInt(e.target.value) || 0 })}
                          style={{ width: "100%", padding: 8, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 13 }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>Timeout (ms)</label>
                        <input type="number" step="1000" value={m.timeoutMs ?? 20000}
                          onChange={e => updateModel(selectedModel, { timeoutMs: parseInt(e.target.value) || 0 })}
                          style={{ width: "100%", padding: 8, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 13 }} />
                      </div>
                    </div>

                    <div style={{ marginTop: 24, padding: 12, background: "#161b22", borderRadius: 6, border: "1px solid #30363d" }}>
                      <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 6 }}>配置预览</div>
                      <pre style={{ fontSize: 11, color: "#c9d1d9", margin: 0, whiteSpace: "pre-wrap" }}>
{JSON.stringify(m, null, 2)}
                      </pre>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {tab === "tools" && (
          <div style={{ display: "flex", gap: 20, height: "calc(100% - 50px)" }}>
            {/* Tool selector */}
            <div style={{ width: 220, borderRight: "1px solid #21262d", overflow: "auto", paddingRight: 12 }}>
              {TOOL_IDS.map(t => {
                const data = getTool(t.id);
                return (
                  <div key={t.id}
                    onClick={() => setSelectedTool(t.id)}
                    style={{ padding: "8px 10px", marginBottom: 4, borderRadius: 6, cursor: "pointer", background: selectedTool === t.id ? "#1a3022" : "transparent", border: selectedTool === t.id ? "1px solid #3fb950" : "1px solid transparent", }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: data.enabled !== false ? "#3fb950" : "#da3633", flexShrink: 0 }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#c9d1d9" }}>{t.label}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#484f58" }}>{t.desc}</div>
                  </div>
                );
              })}
            </div>

            {/* Tool editor */}
            <div style={{ flex: 1 }}>
              {(() => {
                const t = getTool(selectedTool);
                const def = TOOL_IDS.find(d => d.id === selectedTool);
                return (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#c9d1d9" }}>{def?.label || selectedTool}</span>
                      <code style={{ fontSize: 10, padding: "2px 6px", background: "#21262d", borderRadius: 3, color: "#8b949e" }}>{selectedTool}</code>
                      <span style={{ marginLeft: "auto" }}>
                        <button onClick={() => updateTool(selectedTool, { enabled: !(t.enabled !== false) })}
                          style={{ padding: "6px 16px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: t.enabled !== false ? "#1a3022" : "#2a1a1a", color: t.enabled !== false ? "#3fb950" : "#da3633" }}>
                          {t.enabled !== false ? "🟢 启用" : "🔴 禁用"}
                        </button>
                      </span>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                      <div>
                        <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>Timeout (ms)</label>
                        <input type="number" step="500" value={t.timeoutMs ?? 10000}
                          onChange={e => updateTool(selectedTool, { timeoutMs: parseInt(e.target.value) || 0 })}
                          style={{ width: "100%", padding: 8, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 13 }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>重试次数</label>
                        <input type="number" step="1" min="0" max="5" value={t.retry ?? 1}
                          onChange={e => updateTool(selectedTool, { retry: parseInt(e.target.value) || 0 })}
                          style={{ width: "100%", padding: 8, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 13 }} />
                      </div>
                    </div>

                    <div style={{ marginTop: 16 }}>
                      <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 4 }}>备注</label>
                      <textarea value={t.notes || ""}
                        onChange={e => updateTool(selectedTool, { notes: e.target.value })}
                        rows={4}
                        placeholder="记录工具用途、注意事项..."
                        style={{ width: "100%", padding: 8, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12, resize: "vertical" }} />
                    </div>

                    <div style={{ marginTop: 16, padding: 12, background: "#161b22", borderRadius: 6, border: "1px solid #30363d" }}>
                      <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 6 }}>
                        状态 · 状态: {t.enabled !== false ? "🟢 启用" : "🔴 禁用"} · 超时: {t.timeoutMs || 10000}ms · 重试: {t.retry ?? 1}次
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-tab button style ──
function subTabStyle(active: boolean): CSSProperties {
  return {
    display: "block", width: "100%", padding: "8px 12px", marginBottom: 4,
    background: active ? "#161b22" : "transparent",
    color: active ? "#58a6ff" : "#8b949e",
    border: "none", borderLeft: active ? "3px solid #58a6ff" : "3px solid transparent",
    borderRadius: 4, cursor: "pointer", fontSize: 13, textAlign: "left" as const,
  };
}
