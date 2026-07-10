"use client";

import { useState, useEffect, useCallback } from "react";

// ── Pipeline definition ──

type PipeNode = {
  id: string;
  label: string;
  layer: "entry" | "intent" | "dispatch" | "handler" | "memory" | "data" | "postprocess" | "monitor" | "output";
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
  { id: "handler", label: "Handler", color: "#e17055" },
  { id: "memory", label: "记忆", color: "#0984e3" },
  { id: "data", label: "数据", color: "#00cec9" },
  { id: "postprocess", label: "后置", color: "#a29bfe" },
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
    description: "规则优先 + 样本匹配 + LLM fallback。8 种意图，支持单/多意图识别、正向/负向规则、上下文条件。完整配置在 Intent Config tab。",
    file: "lib/beer-agent/intent-classifier.ts",
    configurable: [
      { key: "ruleConfidenceThreshold", label: "规则置信度阈值", value: 0.7, type: "number" },
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
    description: "占位 handler。回复引导用户用'清空'重置上下文。后续版本实现真正的纠正。",
    file: "lib/beer-agent/handlers/memory-correction.ts",
  },
  {
    id: "handler-unclear", label: "Unclear\n意图不明", layer: "handler",
    description: "根据是否有图片发不同追问：'想让我看酒单推荐，还是检查这瓶酒？' / '想推荐啤酒、记录喝过的酒，还是了解啤酒知识？'",
    file: "lib/beer-agent/handlers/unclear.ts",
  },
  {
    id: "memory-short", label: "Short-Term Memory\n短期记忆", layer: "memory",
    description: "按 conversationId 存储：上轮酒单候选、picks、活跃啤酒、最近 20 轮对话。路径 data/memory/short-term/{id}.json",
    file: "lib/beer-agent/memory/short-term.ts",
  },
  {
    id: "memory-episodic", label: "Episodic Memory\n品饮记录", layer: "memory",
    description: "按 userId 存储每次品饮反馈。路径 data/memory/users/{userId}/episodes.json",
    file: "lib/beer-agent/memory/episodic.ts",
  },
  {
    id: "memory-profile", label: "Profile Memory\n口味画像", layer: "memory",
    description: "从所有品饮记录聚合：偏好/讨厌的风格和标签、ABV 舒适区间。路径 data/memory/users/{userId}/profile.json",
    file: "lib/beer-agent/memory/profile.ts",
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
    id: "intent-multi", label: "Multi-Intent\n多意图识别", layer: "intent",
    description: "支持单意图和多意图两种模式。当多个规则置信度接近（<0.15）时，返回多意图结果。主意图路由到对应 Handler，副意图信息传给 Handler context。",
    file: "lib/beer-agent/intent-classifier.ts",
    configurable: [
      { key: "multiIntentGap", label: "多意图间隔阈值", value: 0.15, type: "number" },
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
  ["dispatcher", "handler-menu"],
  ["dispatcher", "handler-followup"],
  ["dispatcher", "handler-feedback"],
  ["dispatcher", "handler-profile"],
  ["dispatcher", "handler-knowledge"],
  ["dispatcher", "handler-label"],
  ["dispatcher", "handler-correction"],
  ["dispatcher", "handler-unclear"],
  ["handler-menu", "beer-db"],
  ["handler-menu", "recommendation"],
  ["handler-label", "beer-db"],
  ["handler-followup", "memory-short"],
  ["handler-feedback", "memory-episodic"],
  ["handler-feedback", "memory-profile"],
  ["handler-profile", "memory-profile"],
  ["memory-episodic", "long-term-memory"],
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
  ["memory-short", "orchestrator"],
];

// ── Color map ──
const layerColor = Object.fromEntries(layers.map(l => [l.id, l.color]));

export default function PipelinePage() {
  const [selectedNode, setSelectedNode] = useState<PipeNode | null>(null);
  const [editing, setEditing] = useState<Record<string, Record<string, any>>>({});
  const [intentOverrides, setIntentOverrides] = useState<Array<{ regex: string; intent: string; note?: string }>>([]);
  const [view, setView] = useState<"pipeline" | "cases" | "intent-test" | "intent-config" | "metrics" | "memory-trace" | "benchmark">("pipeline");

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
  // The pipeline is arranged in 4 horizontal lanes:
  //   Lane 1 (top):   orchestrator → intent → dispatcher → handlers → guardrails → trace
  //   Lane 2 (mid):   memory modules (shortTerm → episodic → profile → longTerm → tagGuess)
  //   Lane 3 (bot):   data modules (beerDb, recommendation)
  //   Lane 4:         monitor (side channel)
  //
  // X-axis: 0=entry, 1=intent, 2=dispatch, 3=handlers, 4=data/rec, 5=postprocess, 6=output

  const NODE_W = 150, NODE_H = 56;
  const nodePositions: Record<string, { x: number; y: number }> = {};

  // ── Main pipeline lane (y=40) ──
  const MAIN_Y = 40;
  // entry
  nodePositions["orchestrator"]      = { x: 30,  y: MAIN_Y };
  // intent
  nodePositions["intent-classifier"] = { x: 210, y: MAIN_Y };
  nodePositions["intent-multi"]      = { x: 210, y: MAIN_Y + 80 };
  // dispatch
  nodePositions["dispatcher"]        = { x: 390, y: MAIN_Y };
  // handlers (two columns, each 4 rows)
  nodePositions["handler-menu"]       = { x: 570, y: 20 };
  nodePositions["handler-followup"]   = { x: 570, y: 82 };
  nodePositions["handler-feedback"]   = { x: 570, y: 144 };
  nodePositions["handler-profile"]    = { x: 570, y: 206 };
  nodePositions["handler-knowledge"]  = { x: 740, y: 20 };
  nodePositions["handler-label"]      = { x: 740, y: 82 };
  nodePositions["handler-correction"] = { x: 740, y: 144 };
  nodePositions["handler-unclear"]    = { x: 740, y: 206 };
  // postprocess
  nodePositions["guardrails"]        = { x: 910, y: MAIN_Y + 60 };
  // output
  nodePositions["trace"]             = { x: 1090, y: MAIN_Y };

  // ── Memory lane (y=300) ──
  const MEM_Y = 300;
  nodePositions["memory-short"]      = { x: 350, y: MEM_Y };
  nodePositions["memory-episodic"]   = { x: 530, y: MEM_Y };
  nodePositions["memory-profile"]    = { x: 710, y: MEM_Y };
  nodePositions["long-term-memory"]  = { x: 890, y: MEM_Y };
  nodePositions["profile-tags"]      = { x: 1070, y: MEM_Y };

  // ── Data lane (y=400) ──
  nodePositions["beer-db"]           = { x: 570, y: 400 };
  nodePositions["recommendation"]    = { x: 750, y: 400 };

  // ── Monitor lane (y=500) ──
  nodePositions["monitor"]           = { x: 1090, y: 500 };

  const maxX = Math.max(...Object.values(nodePositions).map(p => p.x + NODE_W)) + 40;
  const maxY = Math.max(...Object.values(nodePositions).map(p => p.y + NODE_H)) + 40;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: "system-ui", background: "#0d1117", color: "#c9d1d9" }}>
      {/* Top nav */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #30363d", padding: "0 16px" }}>
        <button onClick={() => setView("pipeline")}
          style={{ padding: "10px 20px", background: view === "pipeline" ? "#161b22" : "transparent", color: view === "pipeline" ? "#58a6ff" : "#8b949e", border: "none", borderBottom: view === "pipeline" ? "2px solid #58a6ff" : "2px solid transparent", cursor: "pointer", fontSize: 14 }}>
          Pipeline
        </button>
        <button onClick={() => setView("cases")}
          style={{ padding: "10px 20px", background: view === "cases" ? "#161b22" : "transparent", color: view === "cases" ? "#58a6ff" : "#8b949e", border: "none", borderBottom: view === "cases" ? "2px solid #58a6ff" : "2px solid transparent", cursor: "pointer", fontSize: 14 }}>
          Cases
        </button>
        <button onClick={() => setView("intent-test")}
          style={{ padding: "10px 20px", background: view === "intent-test" ? "#161b22" : "transparent", color: view === "intent-test" ? "#58a6ff" : "#8b949e", border: "none", borderBottom: view === "intent-test" ? "2px solid #58a6ff" : "2px solid transparent", cursor: "pointer", fontSize: 14 }}>
          Intent Test
        </button>
        <button onClick={() => setView("intent-config")}
          style={{ padding: "10px 20px", background: view === "intent-config" ? "#161b22" : "transparent", color: view === "intent-config" ? "#58a6ff" : "#8b949e", border: "none", borderBottom: view === "intent-config" ? "2px solid #58a6ff" : "2px solid transparent", cursor: "pointer", fontSize: 14 }}>
          Intent Config
        </button>
        <button onClick={() => setView("metrics")}
          style={{ padding: "10px 20px", background: view === "metrics" ? "#161b22" : "transparent", color: view === "metrics" ? "#58a6ff" : "#8b949e", border: "none", borderBottom: view === "metrics" ? "2px solid #58a6ff" : "2px solid transparent", cursor: "pointer", fontSize: 14 }}>
          Metrics
        </button>
        <button onClick={() => setView("memory-trace")}
          style={{ padding: "10px 20px", background: view === "memory-trace" ? "#161b22" : "transparent", color: view === "memory-trace" ? "#58a6ff" : "#8b949e", border: "none", borderBottom: view === "memory-trace" ? "2px solid #58a6ff" : "2px solid transparent", cursor: "pointer", fontSize: 14 }}>
          Memory Trace
        </button>
        <button onClick={() => setView("benchmark")}
          style={{ padding: "10px 20px", background: view === "benchmark" ? "#161b22" : "transparent", color: view === "benchmark" ? "#58a6ff" : "#8b949e", border: "none", borderBottom: view === "benchmark" ? "2px solid #58a6ff" : "2px solid transparent", cursor: "pointer", fontSize: 14 }}>
          Benchmark
        </button>
        <span style={{ marginLeft: "auto", alignSelf: "center", fontSize: 12, color: "#58a6ff" }}>Beer Lens Pipeline</span>
      </div>

      {view === "cases" ? (
        <CaseView />
      ) : view === "intent-test" ? (
        <IntentTestView />
      ) : view === "intent-config" ? (
        <IntentConfigView />
      ) : view === "metrics" ? (
        <MetricsView />
      ) : view === "memory-trace" ? (
        <MemoryTraceView />
      ) : view === "benchmark" ? (
        <BenchmarkView />
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

function MetricsView() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetchMetrics = useCallback(async () => {
    try {
      const r = await fetch("/api/metrics");
      const d = await r.json();
      setData(d);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 10000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  if (loading || !data) {
    return <div style={{ flex: 1, padding: 20, color: "#484f58" }}>加载中...</div>;
  }

  const findMetric = (name: string) => data.counters?.find((c: any) => c.name === name)?.value ?? 0;
  const totalTurns = findMetric("turn.count");
  const avgLatency = findMetric("turn.avg_latency_ms");
  const successRate = findMetric("turn.success_rate");
  const ruleHitRate = findMetric("intent.hit_rate_rule");
  const llmHitRate = findMetric("intent.hit_rate_llm");
  const fallbackRate = findMetric("intent.hit_rate_fallback");
  const multiIntentRate = findMetric("intent.multi_intent_rate");
  const handlerErrorRate = findMetric("handler.error_rate");
  const knowledgeHitRate = findMetric("knowledge.hit_rate");
  const guardrailBlockRate = findMetric("guardrail.block_rate");
  const transferCount = findMetric("transfer.human_suggestions");

  const intentDist = data.intentDistribution || {};

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 16, color: "#58a6ff" }}>运行监控看板</h3>
        <div style={{ fontSize: 11, color: "#484f58" }}>
          每10秒刷新 · 窗口 {data.windowSeconds ?? 0}s · {data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : ""}
        </div>
      </div>

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        <MetricCard label="总调用次数" value={totalTurns} unit="次" color="#58a6ff" />
        <MetricCard label="平均延迟" value={avgLatency} unit="ms" color="#3fb950" warn={avgLatency > 3000} />
        <MetricCard label="成功率" value={(successRate * 100).toFixed(1)} unit="%" color={successRate > 0.95 ? "#3fb950" : "#d4a017"} />
        <MetricCard label="转人工建议" value={transferCount} unit="次" color={transferCount > 0 ? "#da3633" : "#484f58"} />
      </div>

      {/* Intent distribution */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "#58a6ff" }}>意图来源分布</h4>
          <ProgressBar label="规则匹配" value={ruleHitRate} max={1} color="#3fb950" />
          <ProgressBar label="LLM识别" value={llmHitRate} max={1} color="#58a6ff" />
          <ProgressBar label="兜底/失败" value={fallbackRate} max={1} color="#da3633" />
          <div style={{ marginTop: 12, fontSize: 12, color: "#8b949e" }}>
            多意图率: {(multiIntentRate * 100).toFixed(1)}%
          </div>
        </div>

        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "#58a6ff" }}>各类意图调用分布</h4>
          {Object.keys(intentDist).length === 0 && (
            <div style={{ color: "#484f58", fontSize: 12 }}>暂无数据</div>
          )}
          {Object.entries(intentDist).sort(([, a], [, b]) => (b as number) - (a as number)).map(([name, count]) => (
            <ProgressBar key={name} label={name} value={count as number} max={totalTurns} color="#00cec9" />
          ))}
        </div>
      </div>

      {/* Quality metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "#58a6ff" }}>质量指标</h4>
          <ProgressBar label="知识库命中率" value={knowledgeHitRate} max={1} color={knowledgeHitRate > 0.5 ? "#3fb950" : "#d4a017"} />
          <ProgressBar label="护栏拦截率" value={guardrailBlockRate} max={1} color={guardrailBlockRate > 0.1 ? "#da3633" : "#3fb950"} warn={guardrailBlockRate > 0.1} />
          <ProgressBar label="Handler异常率" value={handlerErrorRate} max={1} color={handlerErrorRate > 0.05 ? "#da3633" : "#3fb950"} warn={handlerErrorRate > 0.05} />
        </div>

        <div style={{ background: "#161b22", borderRadius: 8, padding: 16, border: "1px solid #30363d" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "#58a6ff" }}>Handler 错误分布</h4>
          {data.handlerErrors && Object.keys(data.handlerErrors).length > 0 ? (
            Object.entries(data.handlerErrors).map(([name, count]) => (
              <div key={name} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12, color: name === Object.keys(data.handlerErrors)[0] ? "#da3633" : "#c9d1d9" }}>
                <span>{name}</span>
                <span>{count as number} 次</span>
              </div>
            ))
          ) : (
            <div style={{ color: "#3fb950", fontSize: 12 }}>✅ 无异常</div>
          )}
        </div>
      </div>
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
        <span style={{ color: warn ? "#da3633" : "#c9d1d9" }}>{(pct).toFixed(1)}%</span>
      </div>
      <div style={{ height: 6, background: "#0d1117", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: warn ? "#da3633" : color, borderRadius: 3, transition: "width 0.3s" }} />
      </div>
    </div>
  );
}

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

function CaseView() {
  const [cases, setCases] = useState<any[]>([]);
  const [filter, setFilter] = useState({ status: "", label: "" });
  const [selected, setSelected] = useState<any>(null);
  const [trace, setTrace] = useState<any>(null);

  const LABELS = ["good", "intent_wrong","ocr_wrong","recommendation_bad","hallucination","memory_wrong","data_missing","response_bad"];

  const fetchCases = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter.status) params.set("status", filter.status);
    if (filter.label) params.set("label", filter.label);
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
    try {
      const r = await fetch(`/api/cases/${c.id}`);
      if (r.ok) setTrace((await r.json()).trace);
    } catch {}
  };

  const setLabel = async (id: string, label: string) => {
    await fetch(`/api/cases/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }) });
    fetchCases();
    if (selected?.id === id) setSelected({ ...selected, label });
  };

  const labelColor = (label: string | null) => {
    if (!label) return "#484f58";
    if (label === "good") return "#238636";
    return "#da3633";
  };

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      <div style={{ width: 380, borderRight: "1px solid #30363d", overflow: "auto", padding: 16 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <select value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}
            style={{ flex: 1, padding: 6, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12 }}>
            <option value="">All</option>
            <option value="unlabeled">Unlabeled</option>
            <option value="reviewed">Reviewed</option>
            <option value="fixed">Fixed</option>
            <option value="ignored">Ignored</option>
          </select>
          <select value={filter.label} onChange={e => setFilter(f => ({ ...f, label: e.target.value }))}
            style={{ flex: 1, padding: 6, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12 }}>
            <option value="">All labels</option>
            {LABELS.map(l => <option key={l}>{l}</option>)}
          </select>
        </div>
        <button onClick={fetchCases} style={{ width: "100%", padding: 6, marginBottom: 12, background: "#21262d", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>
          Refresh ({cases.length} cases)
        </button>
        {cases.map(c => (
          <div key={c.id} onClick={() => openDetail(c)}
            style={{ padding: 10, marginBottom: 6, cursor: "pointer", borderRadius: 6, background: selected?.id === c.id ? "#161b22" : "#0d1117", border: selected?.id === c.id ? "1px solid #58a6ff" : "1px solid #21262d" }}>
            <div style={{ fontSize: 12, color: "#c9d1d9", marginBottom: 4, fontWeight: 500 }}>
              {c.input.text.slice(0, 60)}{c.input.hasImage ? " 🖼" : ""}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
              <span style={{ color: "#8b949e" }}>{c.intent.name}</span>
              <span style={{ padding: "1px 6px", borderRadius: 3, background: labelColor(c.label), color: "#fff", fontSize: 10 }}>
                {c.label || "unlabeled"}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {!selected && <p style={{ color: "#484f58", marginTop: 80, textAlign: "center" }}>Select a case</p>}
        {selected && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: "0 0 4px" }}>{selected.input.text.slice(0, 80)}</h3>
                <span style={{ fontSize: 12, color: "#8b949e" }}>
                  Intent: {selected.intent.name} ({selected.intent.confidence}) · {selected.candidateCount} candidates
                  {selected.input.hasImage ? " · 🖼 image" : ""}
                </span>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>Label</div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", maxWidth: 280 }}>
                  {LABELS.map(l => (
                    <button key={l} onClick={() => setLabel(selected.id, l)}
                      style={{ padding: "3px 8px", fontSize: 10, background: selected.label === l ? labelColor(l) : "#21262d", color: selected.label === l ? "#fff" : "#8b949e", border: "1px solid #30363d", borderRadius: 4, cursor: "pointer" }}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ padding: 12, background: "#161b22", borderRadius: 6, border: "1px solid #30363d", marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>Reply</div>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#c9d1d9", margin: 0 }}>{selected.replyPreview}</pre>
            </div>
            {selected.warnings?.length > 0 && (
              <div style={{ padding: 12, background: "#da363310", borderRadius: 6, border: "1px solid #da363344", marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: "#da3633", marginBottom: 4 }}>Warnings ({selected.warnings.length})</div>
                {selected.warnings.map((w: string, i: number) => (
                  <div key={i} style={{ fontSize: 11, color: "#f0883e" }}>{w}</div>
                ))}
              </div>
            )}
            {/* Note & Expected */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>分析备注 (原因/分析)</div>
              <textarea
                placeholder="写详细分析：为什么标记这个标签、哪个环节出了问题..."
                value={selected.note || ""}
                onChange={e => setSelected({ ...selected, note: e.target.value })}
                onBlur={() => saveDetail(selected.id, { note: selected.note || "" })}
                style={{ width: "100%", minHeight: 80, padding: 8, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 6, fontSize: 12, resize: "vertical", fontFamily: "system-ui" }}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>期望意图</div>
                <select
                  value={selected.expected?.intent || ""}
                  onChange={e => saveDetail(selected.id, { expected: { ...selected.expected, intent: e.target.value || undefined } })}
                  style={{ width: "100%", padding: 6, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12 }}>
                  <option value="">(未设置)</option>
                  {["menu_recommend","follow_up_filter","tasting_feedback","profile_query","beer_knowledge","label_check","memory_correction","unclear"].map(i => <option key={i}>{i}</option>)}
                </select>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>期望酒名</div>
                <input
                  placeholder="(未设置)"
                  value={selected.expected?.beerName || ""}
                  onChange={e => saveDetail(selected.id, { expected: { ...selected.expected, beerName: e.target.value || undefined } })}
                  style={{ width: "100%", padding: 6, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12 }}
                />
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>期望回复</div>
              <textarea
                placeholder="(未设置) 写下你认为正确的回复应该是什么样的..."
                value={selected.expected?.reply || ""}
                onChange={e => setSelected({ ...selected, expected: { ...selected.expected, reply: e.target.value } })}
                onBlur={() => saveDetail(selected.id, { expected: selected.expected })}
                style={{ width: "100%", minHeight: 60, padding: 8, background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 6, fontSize: 12, resize: "vertical", fontFamily: "system-ui" }}
              />
            </div>
            {trace && (
              <details style={{ marginBottom: 12 }}>
                <summary style={{ cursor: "pointer", fontSize: 12, color: "#58a6ff" }}>Full Trace</summary>
                <pre style={{ marginTop: 8, padding: 12, background: "#161b22", borderRadius: 6, fontSize: 10, whiteSpace: "pre-wrap", border: "1px solid #30363d", maxHeight: 300, overflow: "auto" }}>
                  {JSON.stringify(trace, null, 2)}
                </pre>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
