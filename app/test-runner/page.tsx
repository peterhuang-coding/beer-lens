"use client";

import { useState, useEffect, useCallback, useRef, useMemo, type CSSProperties } from "react";
import Nav from "../_components/Nav";

// ── Types ──

type TestCase = {
  id: string;
  name: string;
  inputText: string;
  expectedIntent: string;
  expectedMinCandidates?: number;
  expectedKeywords?: string[];
  tags?: string[];
  note?: string;
  source: "regression" | "vqa";
  query?: string;
  multiTurn?: boolean;
};

type TestResult = {
  caseId: string;
  actualIntent: string;
  actualReply: string;
  candidateCount: number;
  candidateNames: string[];
  passed: boolean;
  failures: string[];
  elapsedMs: number;
};

// ── Theme ──

const C = {
  bg: "#0d1117", card: "#161b22", border: "#30363d",
  text: "#c9d1d9", dim: "#8b949e", accent: "#58a6ff",
  green: "#3fb950", red: "#f85149", orange: "#d29922", purple: "#bc8cff",
};

const intentColor: Record<string, string> = {
  menu_recommend: "#1f6feb", follow_up_filter: "#8957e5", tasting_feedback: "#2ea043",
  profile_query: "#d29922", beer_knowledge: "#f85149", label_check: "#bc8cff",
  memory_correction: "#f0883e", unclear: "#8b949e",
};

function tag(i: string) {
  return { display: "inline-block", padding: "2px 6px", borderRadius: 4, fontSize: 11,
    fontWeight: 600, color: "#fff", background: intentColor[i] || C.purple } as CSSProperties;
}

// ── Helpers ──

function autoExpected(e: string, multi: boolean): string {
  return e === "follow_up_filter" && !multi ? "menu_recommend" : e;
}

// ── Component ──

export default function TestRunnerPage() {
  const [regCases, setRegCases] = useState<TestCase[]>([]);
  const [vqaTasks, setVqaTasks] = useState<TestCase[]>([]);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [fi, setFi] = useState("all");
  const [fs, setFs] = useState("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const abortRef = useRef(false);
  const runQueueRef = useRef<TestCase[]>([]);

  // Load data once
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/data/regression-cases.json").then(r => r.json()),
      fetch("/data/vqa-tasks.json").then(r => r.json()),
    ]).then(([reg, vqa]) => {
      if (cancelled) return;
      const r: TestCase[] = reg.map((c: any) => ({
        ...c, source: "regression" as const, inputText: c.inputText || "", multiTurn: false,
      }));
      const v: TestCase[] = vqa.map((t: any) => {
        let inputText = "";
        try { const m = JSON.parse(t.query); if (Array.isArray(m)) inputText = m[m.length-1]?.content || ""; } catch { inputText = t.query || ""; }
        return {
          id: t.id, name: t.title || t.id, inputText,
          expectedIntent: t.labels?.passCriteria?.intent || "unknown",
          expectedMinCandidates: t.labels?.passCriteria?.minCandidates,
          expectedKeywords: [], tags: ["vqa"], note: t.description,
          source: "vqa" as const, query: t.query,
          multiTurn: (() => { try { const m = JSON.parse(t.query); return Array.isArray(m) && m.length >= 3; } catch { return false; } })(),
        };
      });
      setRegCases(r);
      setVqaTasks(v);
      setLoading(false);
    }).catch((err: any) => {
      if (cancelled) return;
      setLoadErr(String(err?.message ?? err));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const allCases = useMemo(() => [...regCases, ...vqaTasks], [regCases, vqaTasks]);

  const filtered = useMemo(() => {
    return allCases.filter(tc => {
      if (fi !== "all" && tc.expectedIntent !== fi) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!tc.id.toLowerCase().includes(q) && !tc.name.toLowerCase().includes(q) &&
            !tc.inputText.toLowerCase().includes(q) && !tc.expectedIntent.toLowerCase().includes(q)) return false;
      }
      if (fs !== "all") {
        const r = results[tc.id];
        if (fs === "pass" && (!r || !r.passed)) return false;
        if (fs === "fail" && (!r || r.passed)) return false;
        if (fs === "pending" && r) return false;
        if (fs === "error" && (!r || r.actualIntent !== "error")) return false;
      }
      return true;
    });
  }, [allCases, fi, fs, search, results]);

  const intents = useMemo(() => Array.from(new Set(allCases.map(tc => tc.expectedIntent))).sort(), [allCases]);

  const runSingle = useCallback(async (tc: TestCase): Promise<TestResult> => {
    const start = Date.now();
    try {
      const messages = tc.query ? JSON.parse(tc.query) : [{ role: "user", content: tc.inputText }];
      const res = await fetch("/api/agent", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "test-runner", conversationId: `test-runner-${tc.id}`, messages }),
      });
      if (!res.ok) {
        return { caseId: tc.id, actualIntent: "error", actualReply: "", candidateCount: 0, candidateNames: [], passed: false, failures: [`HTTP ${res.status}`], elapsedMs: Date.now() - start };
      }
      const data = await res.json();
      const ai = data.intentResult?.intent || data.mode || "unknown";
      const reply = data.reply || "";
      const cc = data.candidates?.length || 0;
      const cn = (data.candidates || []).map((c: any) => c.displayName || c.name || "").filter(Boolean);
      const failures: string[] = [];
      const ae = autoExpected(tc.expectedIntent, !!tc.multiTurn);
      if (ai !== ae) failures.push(`意图不匹配: 预期=${ae}, 实际=${ai}`);
      if (tc.expectedMinCandidates != null && tc.expectedMinCandidates > 0 && cc < tc.expectedMinCandidates) {
        failures.push(`候选数不足: 预期>=${tc.expectedMinCandidates}, 实际=${cc}`);
      }
      if (tc.expectedKeywords && tc.expectedKeywords.length > 0) {
        const missing = tc.expectedKeywords.filter(kw => !reply.toLowerCase().includes(kw.toLowerCase()));
        if (missing.length > 0) failures.push(`缺少关键词: [${missing.join(", ")}]`);
      }
      if (!reply.trim()) failures.push("回复为空");
      if (data.error) failures.push(`API错误: ${data.error}`);
      if (["抱歉，处理你的请求时出错了", "请再试一次"].some(p => reply.includes(p))) failures.push("回复为错误回退");
      return { caseId: tc.id, actualIntent: ai, actualReply: reply.slice(0, 500), candidateCount: cc, candidateNames: cn, passed: failures.length === 0, failures, elapsedMs: Date.now() - start };
    } catch (err: any) {
      return { caseId: tc.id, actualIntent: "error", actualReply: "", candidateCount: 0, candidateNames: [], passed: false, failures: [`请求异常: ${err.message}`], elapsedMs: Date.now() - start };
    }
  }, []);

  const runAll = useCallback(async () => {
    if (running) return;
    abortRef.current = false;
    setRunning(true);
    const list = filtered;
    setProgress({ done: 0, total: list.length });
    for (let i = 0; i < list.length; i++) {
      if (abortRef.current) break;
      const r = await runSingle(list[i]);
      setResults(prev => ({ ...prev, [list[i].id]: r }));
      setProgress({ done: i + 1, total: list.length });
    }
    setRunning(false);
  }, [filtered, runSingle, running]);

  const stats = useMemo(() => {
    const rs = Object.values(results);
    return { total: rs.length, pass: rs.filter(r => r.passed).length, fail: rs.filter(r => !r.passed).length };
  }, [results]);

  // ── Render ──

  if (loading) return <div style={{ background: C.bg, color: C.text, minHeight: "100vh", padding: 40, fontSize: 16 }}>加载中...</div>;

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh", padding: "20px 24px", fontFamily: "system-ui, sans-serif", fontSize: 14 } as CSSProperties}>
      <Nav active="test-runner" />
      {loadErr ? (
        <div style={{ background: "#3d2f00", border: `1px solid ${C.orange}`, borderRadius: 6, padding: "10px 14px", marginTop: 16, fontSize: 13, color: "#e3b341" } as CSSProperties}>
          ⚠️ 用例数据加载失败:{loadErr} — 请确认 public/data/regression-cases.json 与 public/data/vqa-tasks.json 存在
        </div>
      ) : null}
      <div style={{ background: "#2a2410", border: `1px solid ${C.orange}`, borderRadius: 6, padding: "8px 14px", margin: "16px 0", fontSize: 12, color: "#e3b341" } as CSSProperties}>
        ⚠️ 本页跑的是旧 pipeline <code>POST /api/agent</code>(lib/agent/controller),与 /chat 使用的 lib/harness 路由不是同一套,结论不能直接代表生产聊天行为。
      </div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 12 } as CSSProperties}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 } as CSSProperties}>
          <span style={{ fontSize: 20, fontWeight: 600, color: C.accent }}>🧪 测试运行器</span>
          <span style={{ fontSize: 12, color: C.dim }}>{allCases.length} 个用例</span>
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 13, color: C.dim } as CSSProperties}>
          <span>已测: <b style={{ color: C.text }}>{stats.total}</b></span>
          <span>✅ <b style={{ color: C.green }}>{stats.pass}</b></span>
          <span>❌ <b style={{ color: C.red }}>{stats.fail}</b></span>
          {running && <span style={{ color: C.orange }}>⏳ {progress.done}/{progress.total}</span>}
        </div>
        <div style={{ display: "flex", gap: 8 } as CSSProperties}>
          {running ? (
            <button onClick={() => { abortRef.current = true; setRunning(false); }}
              style={{ background: C.red, color: "#fff", border: "none", borderRadius: 6, padding: "8px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" } as CSSProperties}>
              ✕ 停止
            </button>
          ) : (
            <>
              <button onClick={runAll}
                style={{ background: C.accent, color: "#fff", border: "none", borderRadius: 6, padding: "8px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" } as CSSProperties}>
                ▶ 运行全部
              </button>
              <button onClick={() => { setResults({}); setExpanded(new Set()); }}
                style={{ background: "transparent", color: C.dim, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 18px", fontSize: 13, cursor: "pointer" } as CSSProperties}>
                清除
              </button>
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" } as CSSProperties}>
        <select value={fi} onChange={e => setFi(e.target.value)}
          style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 13 } as CSSProperties}>
          <option value="all">所有意图</option>
          {intents.map(i => <option key={i} value={i}>{i}</option>)}
        </select>
        <select value={fs} onChange={e => setFs(e.target.value)}
          style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 13 } as CSSProperties}>
          <option value="all">所有状态</option>
          <option value="pending">待测</option>
          <option value="pass">✅ 通过</option>
          <option value="fail">❌ 失败</option>
          <option value="error">⚠️ 错误</option>
        </select>
        <input placeholder="搜索..." value={search} onChange={e => setSearch(e.target.value)}
          style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 13, width: 200 } as CSSProperties} />
        <span style={{ fontSize: 12, color: C.dim }}>显示 {filtered.length}/{allCases.length} 条</span>
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto" } as CSSProperties}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 } as CSSProperties}>
          <thead>
            <tr>
              {["ID", "名称", "输入", "预期", "实际", "候选", "耗时", "操作"].map(h =>
                <th key={h} style={{ textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.border}`, color: C.dim, fontWeight: 600, fontSize: 12, whiteSpace: "nowrap" } as CSSProperties}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.map(tc => {
              const r = results[tc.id];
              const exp = expanded.has(tc.id);
              return (
                <tr key={tc.id}>
                  <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` } as CSSProperties}>
                    <span>{tc.id}</span>
                    {tc.multiTurn && <span title="多轮" style={{ fontSize: 10, color: C.orange, marginLeft: 2 }}>🔄</span>}
                    {tc.source === "vqa" && <span title="VQA" style={{ fontSize: 10, color: C.purple, marginLeft: 2 }}>V</span>}
                  </td>
                  <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as CSSProperties}>{tc.name}</td>
                  <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, maxWidth: 250, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.dim, fontSize: 12 } as CSSProperties}>{tc.inputText.slice(0, 60)}</td>
                  <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` } as CSSProperties}><span style={tag(tc.expectedIntent)}>{tc.expectedIntent}</span></td>
                  <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` } as CSSProperties}>
                    {r ? <span style={tag(r.actualIntent)}>{r.actualIntent}</span> : <span style={{ color: C.dim, fontSize: 11 }}>—</span>}
                  </td>
                  <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` } as CSSProperties}>
                    {r != null ? <span style={{ color: (tc.expectedMinCandidates && r.candidateCount < tc.expectedMinCandidates) ? C.red : C.text } as CSSProperties}>{r.candidateCount}</span> : <span style={{ color: C.dim, fontSize: 11 }}>—</span>}
                  </td>
                  <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` } as CSSProperties}>
                    {r ? <span style={{ color: C.dim, fontSize: 11 }}>{r.elapsedMs}ms</span> : <span style={{ color: C.dim, fontSize: 11 }}>—</span>}
                  </td>
                  <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` } as CSSProperties}>
                    {r ? (
                      <span>{r.passed ? <span style={{ color: C.green }}>✅</span> : <span style={{ color: C.red }}>❌</span>}
                        <button onClick={() => { const n = new Set(expanded); exp ? n.delete(tc.id) : n.add(tc.id); setExpanded(n); }}
                          style={{ background: "transparent", color: C.accent, border: `1px solid ${C.border}`, borderRadius: 4, padding: "2px 6px", fontSize: 10, cursor: "pointer", marginLeft: 4 } as CSSProperties}>
                          {exp ? "收起" : "详情"}
                        </button>
                        <button onClick={async () => { const r2 = await runSingle(tc); setResults(prev => ({ ...prev, [tc.id]: r2 })); }}
                          style={{ background: "transparent", color: C.orange, border: `1px solid ${C.border}`, borderRadius: 4, padding: "2px 6px", fontSize: 10, cursor: "pointer", marginLeft: 4 } as CSSProperties}>
                          ↻ 重跑
                        </button>
                      </span>
                    ) : (
                      <button onClick={async () => { const r2 = await runSingle(tc); setResults(prev => ({ ...prev, [tc.id]: r2 })); }}
                        style={{ background: "transparent", color: C.accent, border: `1px solid ${C.border}`, borderRadius: 4, padding: "3px 10px", fontSize: 12, cursor: "pointer" } as CSSProperties}>
                        ▶ 运行
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Details */}
      {filtered.map(tc => {
        const r = results[tc.id];
        if (!r || !expanded.has(tc.id)) return null;
        return (
          <div key={`d-${tc.id}`} style={{ background: C.card, padding: 12, borderRadius: 6, margin: "4px 0", fontSize: 13, lineHeight: 1.6 } as CSSProperties}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: C.accent } as CSSProperties}>
              {tc.id}: {tc.name}
              {r.passed
                ? <span style={{ ...tag("unclear"), background: C.green, marginLeft: 8 }}>✅ 通过</span>
                : <span style={{ ...tag("unclear"), background: C.red, marginLeft: 8 }}>❌ 失败</span>
              }
              <span style={{ marginLeft: 8, color: C.dim, fontSize: 12 }}>{r.elapsedMs}ms</span>
            </div>

            <div style={{ marginBottom: 8 } as CSSProperties}>
              <b style={{ color: C.dim, fontSize: 12 }}>输入:</b>
              <div style={{ background: C.bg, padding: 8, borderRadius: 4, marginTop: 2, whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 12 } as CSSProperties}>{tc.inputText}</div>
            </div>

            <div style={{ display: "flex", gap: 16, marginBottom: 8 } as CSSProperties}>
              <div><b style={{ color: C.dim, fontSize: 12 }}>预期意图:</b> <span style={tag(tc.expectedIntent)}>{tc.expectedIntent}</span></div>
              <div><b style={{ color: C.dim, fontSize: 12 }}>实际意图:</b> <span style={tag(r.actualIntent)}>{r.actualIntent}</span>
                {r.actualIntent !== tc.expectedIntent
                  ? <span style={{ color: C.red, marginLeft: 6, fontSize: 12 }}>✗ 不匹配</span>
                  : <span style={{ color: C.green, marginLeft: 6, fontSize: 12 }}>✓ 匹配</span>}
              </div>
            </div>

            {tc.expectedMinCandidates != null && (
              <div style={{ marginBottom: 8 } as CSSProperties}>
                <b style={{ color: C.dim, fontSize: 12 }}>候选数:</b> 预期 ≥{tc.expectedMinCandidates}, 实际 {r.candidateCount}
                {r.candidateCount >= tc.expectedMinCandidates
                  ? <span style={{ color: C.green, marginLeft: 6, fontSize: 12 }}>✓</span>
                  : <span style={{ color: C.red, marginLeft: 6, fontSize: 12 }}>✗ 不足</span>}
                {r.candidateNames.length > 0 && <div style={{ color: C.dim, fontSize: 12, marginTop: 2 }}>{r.candidateNames.join(", ")}</div>}
              </div>
            )}

            <div style={{ marginBottom: 8 } as CSSProperties}>
              <b style={{ color: C.dim, fontSize: 12 }}>回复:</b>
              <div style={{ background: C.bg, padding: 8, borderRadius: 4, marginTop: 2, whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 12, maxHeight: 200, overflow: "auto" } as CSSProperties}>
                {r.actualReply || "(空)"}
              </div>
            </div>

            {r.failures.length > 0 && (
              <div><b style={{ color: C.red, fontSize: 12 }}>失败原因:</b>
                <ul style={{ margin: "4px 0 0", paddingLeft: 20, color: C.red, fontSize: 12 } as CSSProperties}>
                  {r.failures.map((f, i) => <li key={i}>{f}</li>)}
                </ul>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}