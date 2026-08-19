"use client";

/**
 * /debug — harness observability page.
 *
 * Aligned to the CURRENT /chat pipeline (lib/harness/* + lib/skills/*).
 * Replaces the old /debug page that referenced lib/beer-agent/* (orchestrator,
 * intent-classifier, dispatcher, guardrails, monitor). The old code is gone;
 * the new harness has 8 skills dispatched by routeByLLM → invokeSkill.
 *
 * Tabs:
 *   - Pipeline: 6-node horizontal flow + 8-skill sidebar
 *   - Skills:   table of 8 registered skills with enable toggle
 *   - Tester:   POST /api/chat SSE testbed + 3 quick-pick test images
 *   - Recent:   last 100 chat runs polled from /api/debug/recent
 *   - Config:   env knobs (server-masked secrets) + legacy pipeline-config
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

// ── Constants ──────────────────────────────────────────────────────────────

type TabId = "pipeline" | "skills" | "tester" | "recent" | "stats" | "rules" | "config";

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "pipeline", label: "Pipeline", icon: "🛤" },
  { id: "skills", label: "Skills", icon: "🎯" },
  { id: "tester", label: "Tester", icon: "🧪" },
  { id: "recent", label: "Recent", icon: "🕘" },
  { id: "stats", label: "Stats", icon: "📊" },
  { id: "rules", label: "Rules", icon: "⚖" },
  { id: "config", label: "Config", icon: "⚙" },
];

// 8 builtin skills — mirror of DEFAULT_SKILLS in lib/harness/skill-registry.ts.
// Kept inline (not imported) so the page is self-contained and easy to scan.
const SKILLS: { id: string; label: string; description: string; handler: string }[] = [
  { id: "menu_recommend", label: "酒单推荐", description: "菜单/纯文字推荐(含图片酒单识别)", handler: "../skills/recommend/execute.ts" },
  { id: "follow_up_filter", label: "追问过滤", description: "基于活跃酒单的追问筛选(哪款/IPA/不苦/第3个等)", handler: "../skills/recommend/execute.ts" },
  { id: "tasting_feedback", label: "品饮反馈", description: "解析评分与风味标签,写入 episodic memory", handler: "../skills/taste-feedback/execute.ts" },
  { id: "profile_query", label: "画像查询", description: "查询用户口味画像(偏好风格/风味标签/ABV 区间)", handler: "../skills/profile-query/execute.ts" },
  { id: "beer_knowledge", label: "啤酒知识", description: "纯 LLM 回答啤酒风格/酿造/酒厂知识", handler: "../skills/beer-knowledge/execute.ts" },
  { id: "label_check", label: "酒标检查", description: "拍照单瓶 → 识别酒名/日期/新鲜度风险", handler: "../skills/label-check/execute.ts" },
  { id: "memory_correction", label: "记忆纠正", description: "纠正 AI 的错误记忆(酒名/偏好/记录)", handler: "../skills/memory-correction/execute.ts" },
  { id: "unclear", label: "意图不明", description: "无法识别意图时的兜底,引导用户说明需求", handler: "../skills/fallback/execute.ts" },
];

// 3 test images copied into public/test-assets/.
const TEST_IMAGES = [
  { id: "menu-el-nido", path: "/test-assets/menu-el-nido.png", label: "酒单 (El Nido)", defaultQuery: "这酒单帮我挑一杯 IPA,不要太苦" },
  { id: "can-monkish-la-love", path: "/test-assets/can-monkish-la-love.png", label: "LA LOVE 罐", defaultQuery: "这瓶是什么酒?" },
  { id: "marketing-lunch-dinner", path: "/test-assets/marketing-lunch-dinner.png", label: "Lunch + Dinner 营销卡", defaultQuery: "Lunch 和 Dinner 哪个适合我?我不爱苦" },
] as const;

// Pipeline flow nodes (drawn top-to-bottom in the Pipeline view).
const PIPELINE_NODES = [
  { id: "client", label: "Client /chat", hint: "POST /api/chat" },
  { id: "route", label: "routeByLLM", hint: "router-llm.ts" },
  { id: "rule", label: "keywordRoute", hint: "router-rules.ts — 命中即停" },
  { id: "llm", label: "LLM fallback", hint: "router-llm.ts — 豆包" },
  { id: "invoke", label: "invokeSkill", hint: "router.ts" },
  { id: "exec", label: "executors × 8", hint: "skill-registry.ts + lib/skills/*" },
  { id: "sse", label: "SSE → Client", hint: "meta → result → delta → done" },
] as const;

// ── Page ───────────────────────────────────────────────────────────────────

export default function DebugPage() {
  const [tab, setTab] = useState<TabId>("pipeline");

  return (
    <div style={{ minHeight: "100vh", background: "#0f1115", color: "#e8eaf0", fontFamily: "system-ui", padding: "20px 24px" }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, color: "#f5a524" }}>🛠 /debug</h1>
        <span style={{ fontSize: 13, color: "#9aa3b2" }}>harness observability · {SKILLS.length} builtin skills</span>
        <Link href="/" style={{ marginLeft: "auto", fontSize: 12, color: "#4cb3ff" }}>← home</Link>
      </header>

      {/* Tab strip */}
      <nav style={{ display: "flex", gap: 4, borderBottom: "1px solid #2a2f3a", marginBottom: 20 }}>
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: "8px 16px",
                background: "transparent",
                border: "none",
                borderBottom: active ? "2px solid #4cb3ff" : "2px solid transparent",
                color: active ? "#e8eaf0" : "#9aa3b2",
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                cursor: "pointer",
              }}
            >
              {t.icon} {t.label}
            </button>
          );
        })}
      </nav>

      {tab === "pipeline" ? <PipelineView /> : null}
      {tab === "skills" ? <SkillsView /> : null}
      {tab === "tester" ? <TesterView /> : null}
      {tab === "recent" ? <RecentView /> : null}
      {tab === "stats" ? <StatsView /> : null}
      {tab === "rules" ? <RulesView /> : null}
      {tab === "config" ? <ConfigView /> : null}

      <style jsx>{`
        .card { background: #171a21; border: 1px solid #2a2f3a; border-radius: 8px; padding: 16px; }
        .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
        .pill-ok { background: #166534; color: #d1fae5; }
        .pill-off { background: #7f1d1d; color: #fee2e2; }
        .pill-rule { background: #1e3a8a; color: #bfdbfe; }
        .pill-llm { background: #7c2d12; color: #fed7aa; }
        .pill-error { background: #7f1d1d; color: #fee2e2; }
        .muted { color: #9aa3b2; }
        code { background: #0f1115; padding: 1px 6px; border-radius: 3px; color: #f5a524; font-size: 12px; }
        button { font-family: inherit; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { text-align: left; color: #9aa3b2; padding: 6px 8px; border-bottom: 1px solid #2a2f3a; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
        td { padding: 8px; border-bottom: 1px solid #1f232c; vertical-align: top; }
        tr:hover td { background: #1a1f28; }
      `}</style>
    </div>
  );
}

// ── Pipeline view ──────────────────────────────────────────────────────────

function PipelineView() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 20 }}>
      <div className="card">
        <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#4cb3ff" }}>请求流</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {PIPELINE_NODES.map((n, i) => (
            <div key={n.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{
                width: 110, padding: "8px 10px", background: "#0f1115",
                border: "1px solid #2a2f3a", borderRadius: 6,
                color: "#e8eaf0", fontSize: 12, fontWeight: 600,
              }}>
                {n.label}
              </div>
              <span style={{ color: "#9aa3b2", fontSize: 11 }}>{n.hint}</span>
              {i < PIPELINE_NODES.length - 1 ? (
                <span style={{ marginLeft: "auto", color: "#4cb3ff" }}>↓</span>
              ) : null}
            </div>
          ))}
        </div>
        <p className="muted" style={{ marginTop: 16, fontSize: 12, lineHeight: 1.6 }}>
          路径:客户端 POST <code>/api/chat</code> → <code>routeByLLM</code> 跑 keyword rule,命中走 <code>invokeSkill</code>;未命中走豆包 LLM fallback 选 skill → <code>invokeSkill</code> 在 registry 里查到 executor → 返回 <code>AgentReply</code> → chat route 把它拆成 <code>meta + result + delta + done</code> SSE 事件流回客户端。LLM_COMPOSE_REPLY=1 时 result 之后再叠一层 LLM composer 流式包装回复。
        </p>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#4cb3ff" }}>8 builtin skills</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {SKILLS.map((s) => (
            <div key={s.id} style={{ padding: "6px 8px", background: "#0f1115", border: "1px solid #2a2f3a", borderRadius: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{s.label}</span>
                <code style={{ fontSize: 10 }}>{s.id}</code>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{s.description}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Skills view ────────────────────────────────────────────────────────────

function SkillsView() {
  const [state, setState] = useState<Record<string, boolean>>(() => Object.fromEntries(SKILLS.map((s) => [s.id, true])));
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(id: string) {
    setBusy(id);
    try {
      const r = await fetch(`/api/skills/${id}/toggle`, { method: "POST" });
      if (r.ok) {
        const j = (await r.json()) as { enabled: boolean };
        setState((prev) => ({ ...prev, [id]: j.enabled }));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#4cb3ff" }}>已注册 skills · {SKILLS.length}</h3>
      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>label</th>
            <th>handler</th>
            <th>enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {SKILLS.map((s) => {
            const on = state[s.id];
            return (
              <tr key={s.id}>
                <td><code>{s.id}</code></td>
                <td>{s.label}<div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{s.description}</div></td>
                <td><code style={{ fontSize: 10 }}>{s.handler}</code></td>
                <td>
                  <span className={`pill ${on ? "pill-ok" : "pill-off"}`}>{on ? "ON" : "OFF"}</span>
                </td>
                <td>
                  <button
                    onClick={() => toggle(s.id)}
                    disabled={busy === s.id}
                    style={{
                      padding: "3px 10px", borderRadius: 4,
                      background: on ? "#374151" : "#166534",
                      color: "#e8eaf0", border: "none", cursor: "pointer", fontSize: 11,
                    }}
                  >
                    {busy === s.id ? "…" : on ? "禁用" : "启用"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted" style={{ marginTop: 12, fontSize: 11 }}>
        启用状态写 <code>data/skills/manifest.json</code>,keyword rule 路由会过滤掉 disabled skill。
      </p>
    </div>
  );
}

// ── Tester view ────────────────────────────────────────────────────────────

type TesterEvent = { event: string; data: unknown };

function TesterView() {
  const [text, setText] = useState("推荐一款 NEIPA");
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<TesterEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);

  async function sendWithImage(img: typeof TEST_IMAGES[number]) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setEvents([]);
    setImageName(img.label);
    setText(img.defaultQuery);
    try {
      // Fetch the static image and convert to dataURL so we exercise the
      // exact same code path as a real user upload via the 📎 button.
      const resp = await fetch(img.path);
      const blob = await resp.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
      await send(img.defaultQuery, dataUrl, img.label, blob.type || "image/png");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function send(msg: string, dataUrl?: string, name?: string, type?: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setEvents([]);
    setImageName(name ?? null);
    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          imageDataUrl: dataUrl,
          imageName: name,
          imageType: type,
        }),
      });
      if (!resp.ok || !resp.body) {
        setError(`HTTP ${resp.status}`);
        setBusy(false);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const collected: TesterEvent[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const records = buf.split("\n\n");
        buf = records.pop() ?? "";
        for (const rec of records) {
          const evt = parseSSERecord(rec);
          if (evt) collected.push(evt);
        }
      }
      setEvents(collected);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const meta = events.find((e) => e.event === "meta")?.data as { skill_id?: string; reason?: string } | undefined;
  const result = events.find((e) => e.event === "result")?.data as
    | { reply?: string; candidates?: Array<{ displayName: string; brewery?: string }>; menuImage?: string; hasLabels?: boolean }
    | undefined;
  const done = events.find((e) => e.event === "done")?.data as { skill_id?: string; latency_ms?: number } | undefined;
  const err = events.find((e) => e.event === "error")?.data as { message?: string } | undefined;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
      {/* Left: input */}
      <div className="card">
        <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#4cb3ff" }}>发送请求</h3>

        {/* Quick-pick images */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {TEST_IMAGES.map((img) => (
            <button
              key={img.id}
              onClick={() => sendWithImage(img)}
              disabled={busy}
              title={`Click to attach ${img.path}`}
              style={{
                padding: 4, background: "#0f1115", border: "1px solid #2a2f3a", borderRadius: 4,
                cursor: busy ? "not-allowed" : "pointer", display: "flex", flexDirection: "column",
                alignItems: "center", gap: 2,
              }}
            >
              <img src={img.path} alt={img.label} style={{ width: 80, height: 60, objectFit: "cover", borderRadius: 2 }} />
              <span style={{ fontSize: 10, color: "#9aa3b2" }}>{img.label}</span>
            </button>
          ))}
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          rows={3}
          style={{
            width: "100%", padding: 8, background: "#0f1115", color: "#e8eaf0",
            border: "1px solid #2a2f3a", borderRadius: 4, fontSize: 13, resize: "vertical", fontFamily: "inherit",
          }}
        />
        {imageName ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>📎 attached: {imageName}</div>
        ) : null}
        <button
          onClick={() => send(text)}
          disabled={busy || !text.trim()}
          style={{
            marginTop: 8, padding: "6px 16px",
            background: busy ? "#374151" : "#4cb3ff",
            color: busy ? "#9aa3b2" : "#0f1115",
            border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}
        >
          {busy ? "等待…" : "发送"}
        </button>
        {error ? <div style={{ color: "#da3633", fontSize: 12, marginTop: 8 }}>请求失败: {error}</div> : null}
      </div>

      {/* Right: SSE trace */}
      <div className="card">
        <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#4cb3ff" }}>SSE trace</h3>
        {events.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>点击「发送」或上方任意图片按钮开始。</div>
        ) : (
          <>
            {meta ? (
              <div style={{ marginBottom: 8 }}>
                <span className="pill pill-rule">skill: {meta.skill_id ?? "?"}</span>
                {meta.reason ? <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>{meta.reason}</span> : null}
              </div>
            ) : null}
            {result ? (
              <div style={{ marginBottom: 8, fontSize: 12, lineHeight: 1.5 }}>
                <div className="muted">reply:</div>
                <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0", color: "#e8eaf0" }}>{result.reply ?? ""}</pre>
                <div className="muted">candidates: {result.candidates?.length ?? 0} · menuImage: {result.menuImage ?? "—"} · hasLabels: {String(result.hasLabels ?? false)}</div>
              </div>
            ) : null}
            {err ? (
              <div style={{ color: "#da3633", fontSize: 12 }}>⚠ {err.message ?? "error"}</div>
            ) : null}
            {done ? (
              <div className="muted" style={{ fontSize: 11 }}>latency {done.latency_ms ?? "?"}ms · skill_id={done.skill_id ?? "—"}</div>
            ) : null}
            <details style={{ marginTop: 12 }}>
              <summary className="muted" style={{ fontSize: 11, cursor: "pointer" }}>raw events ({events.length})</summary>
              <pre style={{ marginTop: 6, fontSize: 10, background: "#0f1115", padding: 8, borderRadius: 4, maxHeight: 240, overflow: "auto" }}>
                {events.map((e, i) => `[${i}] ${e.event}: ${JSON.stringify(e.data)}`).join("\n")}
              </pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

function parseSSERecord(rec: string): TesterEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of rec.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const c = line.indexOf(":");
    if (c === -1) continue;
    const field = line.slice(0, c);
    const value = line.slice(c + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    return null;
  }
}

// ── Recent view ────────────────────────────────────────────────────────────

interface TraceEntry {
  ts: number;
  ts_iso: string;
  message: string;
  skill_id: string;
  source: "rule" | "llm" | "none" | "error";
  ok: boolean;
  error_code?: string;
  latency_ms: number;
  candidate_count: number;
  has_image: boolean;
  reason?: string;
  root_ts: number;
  parent_ts: number | null;
  stage: string;
  duration_ms: number;
  decision?: Record<string, unknown>;
  stage_skill_id?: string;
}

function RecentView() {
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [traceRoot, setTraceRoot] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/debug/recent?limit=50");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { entries: TraceEntry[] };
      setEntries(j.entries);
    } catch {
      // ignore — keep previous entries
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="card">
      <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#4cb3ff", display: "flex", alignItems: "center", gap: 8 }}>
        Recent chat runs
        <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>· {entries.length} / 500 · 每 3 秒刷新 · 点击行展开调用树</span>
      </h3>
      {entries.length === 0 && !loading ? (
        <div className="muted" style={{ fontSize: 12 }}>暂无记录。发一条 /chat 请求就会出现在这里。</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: 90 }}>时间</th>
              <th style={{ width: 110 }}>skill</th>
              <th style={{ width: 70 }}>source</th>
              <th style={{ width: 60 }}>ok</th>
              <th style={{ width: 70 }}>latency</th>
              <th style={{ width: 60 }}>cands</th>
              <th style={{ width: 40 }}>img</th>
              <th>message</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => {
              const sourcePill =
                e.source === "rule" ? "pill-rule"
                : e.source === "llm" ? "pill-llm"
                : e.source === "error" ? "pill-error"
                : "pill-off";
              const isExpanded = expanded[e.ts];
              return (
                <tr key={e.ts} onClick={() => setExpanded((p) => ({ ...p, [e.ts]: !p[e.ts] }))} style={{ cursor: "pointer" }}>
                  <td style={{ fontSize: 11 }}>{new Date(e.ts).toLocaleTimeString()}</td>
                  <td><code style={{ fontSize: 10 }}>{e.skill_id}</code></td>
                  <td><span className={`pill ${sourcePill}`}>{e.source}</span></td>
                  <td>
                    <span className={`pill ${e.ok ? "pill-ok" : "pill-error"}`}>{e.ok ? "✓" : "✗"}</span>
                  </td>
                  <td style={{ fontSize: 11 }}>{e.latency_ms}ms</td>
                  <td style={{ fontSize: 11 }}>{e.candidate_count}</td>
                  <td style={{ fontSize: 11 }}>{e.has_image ? "📷" : ""}</td>
                  <td>
                    <div style={{ fontSize: 12 }}>{e.message}</div>
                    {isExpanded ? (
                      <div style={{ marginTop: 6 }}>
                        <button
                          onClick={(ev) => { ev.stopPropagation(); setTraceRoot(e.root_ts); }}
                          style={{
                            padding: "3px 10px", borderRadius: 4,
                            background: "#1e3a8a", color: "#bfdbfe",
                            border: "none", cursor: "pointer", fontSize: 11, marginBottom: 6,
                          }}
                        >
                          查看调用树
                        </button>
                        <pre style={{ fontSize: 10, background: "#0f1115", padding: 6, borderRadius: 4, maxHeight: 160, overflow: "auto" }}>
                          {JSON.stringify(e, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {traceRoot !== null ? <TraceModal rootTs={traceRoot} onClose={() => setTraceRoot(null)} /> : null}
    </div>
  );
}

// ── Stats view ─────────────────────────────────────────────────────────────

interface Stats {
  rpm: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  error_rate: number;
  skill_distribution: Array<{ skill_id: string; count: number }>;
  llm_distribution: Array<{ model: string; count: number; total_ms: number }>;
  rule_hits: Array<{ rule_id: string; count: number; last_fired_at: string | null }>;
  total_requests: number;
  window_minutes: number;
}

function StatsView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/debug/stats");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as Stats;
      setStats(j);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  if (error) {
    return <div className="card" style={{ color: "#da3633", fontSize: 12 }}>stats 加载失败: {error}</div>;
  }
  if (!stats) {
    return <div className="card muted" style={{ fontSize: 12 }}>加载中…</div>;
  }

  const maxLlm = Math.max(1, ...stats.llm_distribution.map((d) => d.count));
  const totalRuleHits = stats.rule_hits.reduce((s, r) => s + r.count, 0);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* KPI tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
        <Kpi label="RPM (5min)" value={stats.rpm} />
        <Kpi label="p50 latency" value={`${stats.p50_latency_ms}ms`} />
        <Kpi label="p95 latency" value={`${stats.p95_latency_ms}ms`} />
        <Kpi label="error rate" value={`${(stats.error_rate * 100).toFixed(1)}%`} />
        <Kpi label="total / 5min" value={`${stats.total_requests}`} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Skill distribution */}
        <div className="card">
          <h3 style={{ margin: "0 0 8px", fontSize: 13, color: "#4cb3ff" }}>Skill distribution</h3>
          {stats.skill_distribution.length === 0 ? (
            <div className="muted" style={{ fontSize: 11 }}>暂无</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {stats.skill_distribution.map((s) => {
                const pct = (s.count / Math.max(1, stats.total_requests)) * 100;
                return (
                  <div key={s.skill_id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <code style={{ fontSize: 10, width: 130 }}>{s.skill_id}</code>
                    <div style={{ flex: 1, height: 14, background: "#0f1115", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: "#4cb3ff" }} />
                    </div>
                    <span style={{ fontSize: 11, color: "#9aa3b2", width: 30, textAlign: "right" }}>{s.count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* LLM distribution */}
        <div className="card">
          <h3 style={{ margin: "0 0 8px", fontSize: 13, color: "#4cb3ff" }}>LLM distribution</h3>
          {stats.llm_distribution.length === 0 ? (
            <div className="muted" style={{ fontSize: 11 }}>暂无</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {stats.llm_distribution.map((d) => {
                const pct = (d.count / maxLlm) * 100;
                const avg = d.count > 0 ? Math.round(d.total_ms / d.count) : 0;
                return (
                  <div key={d.model}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                      <code>{d.model}</code>
                      <span className="muted">{d.count} calls · avg {avg}ms</span>
                    </div>
                    <div style={{ height: 10, background: "#0f1115", borderRadius: 3, overflow: "hidden", marginTop: 2 }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: "#f5a524" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Rule hits */}
      <div className="card">
        <h3 style={{ margin: "0 0 8px", fontSize: 13, color: "#4cb3ff" }}>
          Rule hits
          <span className="muted" style={{ fontSize: 11, fontWeight: 400, marginLeft: 8 }}>
            total {totalRuleHits} fires (since process start)
          </span>
        </h3>
        <table>
          <thead>
            <tr>
              <th>rule_id</th>
              <th style={{ width: 80 }}>count</th>
              <th style={{ width: 180 }}>last fired</th>
            </tr>
          </thead>
          <tbody>
            {stats.rule_hits.map((r) => (
              <tr key={r.rule_id}>
                <td><code style={{ fontSize: 10 }}>{r.rule_id}</code></td>
                <td style={{ fontSize: 11 }}>{r.count}</td>
                <td style={{ fontSize: 11, color: "#9aa3b2" }}>{r.last_fired_at ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#f5a524" }}>{value}</div>
    </div>
  );
}

// ── Rules view ─────────────────────────────────────────────────────────────

interface RuleRow {
  id: string;
  stage: string;
  enabled: boolean;
  priority: number;
  description: string;
}

function RulesView() {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [hits, setHits] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/debug/rules");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { rules: RuleRow[] };
      setRules(j.rules);
      const s = await fetch("/api/debug/stats");
      if (s.ok) {
        const sj = (await s.json()) as { rule_hits: Array<{ rule_id: string; count: number }> };
        setHits(Object.fromEntries(sj.rule_hits.map((h) => [h.rule_id, h.count])));
      }
    } catch { /* keep prior */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  async function toggle(id: string, enabled: boolean) {
    setBusy(id);
    try {
      const r = await fetch(`/api/debug/rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (r.ok) {
        const j = (await r.json()) as { id: string; enabled: boolean };
        setRules((prev) => prev.map((row) => (row.id === j.id ? { ...row, enabled: j.enabled } : row)));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#4cb3ff" }}>
        Hard rules · {rules.length} starter
      </h3>
      <table>
        <thead>
          <tr>
            <th style={{ width: 200 }}>id</th>
            <th style={{ width: 130 }}>stage</th>
            <th style={{ width: 60 }}>priority</th>
            <th style={{ width: 60 }}>hits</th>
            <th style={{ width: 60 }}>enabled</th>
            <th>description</th>
            <th style={{ width: 90 }}></th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td><code style={{ fontSize: 10 }}>{r.id}</code></td>
              <td><code style={{ fontSize: 10, color: "#f5a524" }}>{r.stage}</code></td>
              <td style={{ fontSize: 11 }}>{r.priority}</td>
              <td style={{ fontSize: 11 }}>{hits[r.id] ?? 0}</td>
              <td>
                <span className={`pill ${r.enabled ? "pill-ok" : "pill-off"}`}>{r.enabled ? "ON" : "OFF"}</span>
              </td>
              <td style={{ fontSize: 11 }}>{r.description}</td>
              <td>
                <button
                  onClick={() => toggle(r.id, !r.enabled)}
                  disabled={busy === r.id}
                  style={{
                    padding: "3px 10px", borderRadius: 4,
                    background: r.enabled ? "#374151" : "#166534",
                    color: "#e8eaf0", border: "none", cursor: "pointer", fontSize: 11,
                  }}
                >
                  {busy === r.id ? "…" : r.enabled ? "禁用" : "启用"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ marginTop: 12, fontSize: 11 }}>
        规则定义在 <code>lib/harness/rules.ts</code>;每次触发会写一条 <code>rule:fire</code> stage 到 trace buffer。
        切换 enabled 只影响内存,进程重启会重置为代码默认值。
      </p>
    </div>
  );
}

// ── Trace modal ────────────────────────────────────────────────────────────

function TraceModal({ rootTs, onClose }: { rootTs: number; onClose: () => void }) {
  const [tree, setTree] = useState<TraceEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/debug/trace/${rootTs}`)
      .then((r) => r.json() as Promise<{ tree: TraceEntry[] } | { error: string }>)
      .then((j) => {
        if (!alive) return;
        if ("error" in j) { setErr(j.error); return; }
        setTree(j.tree);
      })
      .catch((e) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [rootTs]);

  // ESC closes
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#171a21", border: "1px solid #2a2f3a", borderRadius: 8,
          padding: 20, maxWidth: 720, maxHeight: "85vh", overflow: "auto",
          width: "90%",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 14, color: "#4cb3ff" }}>
            Trace tree · root_ts={rootTs}
          </h3>
          <button
            onClick={onClose}
            style={{
              padding: "4px 12px", borderRadius: 4, background: "#374151",
              color: "#e8eaf0", border: "none", cursor: "pointer", fontSize: 12,
            }}
          >
            关闭 (ESC)
          </button>
        </div>
        {err ? (
          <div style={{ color: "#da3633", fontSize: 12 }}>加载失败: {err}</div>
        ) : !tree ? (
          <div className="muted" style={{ fontSize: 12 }}>加载中…</div>
        ) : tree.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>该 root_ts 下没有 stage 条目。</div>
        ) : (
          <TraceTree tree={tree} />
        )}
      </div>
    </div>
  );
}

function TraceTree({ tree }: { tree: TraceEntry[] }) {
  // Build parent → children map.
  const childMap = new Map<number | null, TraceEntry[]>();
  for (const e of tree) {
    const key = e.parent_ts;
    const arr = childMap.get(key) ?? [];
    arr.push(e);
    childMap.set(key, arr);
  }
  // Sort children by ts ascending.
  for (const arr of childMap.values()) arr.sort((a, b) => a.ts - b.ts);
  const roots = childMap.get(null) ?? [];
  return (
    <div style={{ fontFamily: "monospace", fontSize: 11 }}>
      {roots.map((r) => <TraceNode key={r.ts} entry={r} childMap={childMap} depth={0} />)}
    </div>
  );
}

function TraceNode({
  entry,
  childMap,
  depth,
}: {
  entry: TraceEntry;
  childMap: Map<number | null, TraceEntry[]>;
  depth: number;
}) {
  const children = childMap.get(entry.ts) ?? [];
  const stageColor =
    entry.stage.startsWith("llm") ? "#f5a524"
    : entry.stage.startsWith("rule") ? "#1e3a8a"
    : entry.stage.startsWith("skill") ? "#166534"
    : entry.stage.startsWith("route") ? "#7c2d12"
    : entry.stage.startsWith("memory") ? "#5b21b6"
    : "#4cb3ff";
  return (
    <div style={{ marginLeft: depth * 14 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "3px 6px", borderLeft: `3px solid ${stageColor}`,
        marginTop: 2, background: depth === 0 ? "#0f1115" : "transparent",
        borderRadius: 2,
      }}>
        <span style={{
          display: "inline-block", padding: "0 6px", borderRadius: 2,
          background: stageColor, color: "#0f1115", fontSize: 10, fontWeight: 700,
        }}>{entry.stage}</span>
        <span style={{ color: "#9aa3b2", fontSize: 10 }}>
          {entry.duration_ms}ms
        </span>
        {!entry.ok ? <span className="pill pill-error" style={{ fontSize: 9 }}>ERR</span> : null}
        {entry.stage_skill_id ? <code style={{ fontSize: 10 }}>{entry.stage_skill_id}</code> : null}
        {entry.decision ? (
          <code style={{ fontSize: 10, color: "#9aa3b2", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 360 }}>
            {summariseDecision(entry.decision)}
          </code>
        ) : null}
      </div>
      {children.map((c) => (
        <TraceNode key={c.ts} entry={c} childMap={childMap} depth={depth + 1} />
      ))}
    </div>
  );
}

function summariseDecision(d: Record<string, unknown>): string {
  const entries = Object.entries(d).slice(0, 5);
  return entries.map(([k, v]) => {
    if (typeof v === "string") return `${k}=${v.length > 24 ? v.slice(0, 24) + "…" : v}`;
    if (typeof v === "number" || typeof v === "boolean") return `${k}=${v}`;
    if (Array.isArray(v)) return `${k}=[${v.length}]`;
    return `${k}=${typeof v}`;
  }).join(" ");
}

// ── Config view ────────────────────────────────────────────────────────────

interface EnvState {
  env: Record<string, string | null>;
}

interface LegacyConfig {
  models?: Record<string, string>;
  prompts?: Record<string, string>;
  intentEngine?: { steps?: Array<{ id: string; enabled: boolean }> };
  routes?: Array<{ intent: string; handler: string; enabled: boolean }>;
}

function ConfigView() {
  const [env, setEnv] = useState<EnvState | null>(null);
  const [legacy, setLegacy] = useState<LegacyConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/debug/env").then((r) => r.json() as Promise<EnvState>),
      fetch("/api/debug-config").then((r) => r.json() as Promise<LegacyConfig>),
    ])
      .then(([e, l]) => {
        setEnv(e);
        setLegacy(l);
      })
      .catch((err) => setError(String(err)));
  }, []);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
      <div className="card">
        <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#4cb3ff" }}>Env (active)</h3>
        <p className="muted" style={{ fontSize: 11, marginTop: 0, marginBottom: 8 }}>
          来自 <code>process.env</code>。密钥服务端 mask 成末 4 位。
        </p>
        {env ? (
          <table>
            <tbody>
              {Object.entries(env.env).map(([k, v]) => (
                <tr key={k}>
                  <td><code style={{ fontSize: 10 }}>{k}</code></td>
                  <td style={{ fontFamily: "monospace", fontSize: 11, color: v === null ? "#6b7280" : "#e8eaf0" }}>
                    {v === null ? "(未设置)" : v}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>加载中…</div>
        )}
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#f5a524" }}>
          Legacy config ⚠
        </h3>
        <p className="muted" style={{ fontSize: 11, marginTop: 0, marginBottom: 8 }}>
          来自 <code>data/pipeline-config.json</code>。这是老 beer-agent 架构的 schema,<strong>当前 harness 不再读它</strong>,仅供参考。
        </p>
        {legacy?.models ? (
          <>
            <h4 style={{ fontSize: 12, color: "#9aa3b2", margin: "8px 0 4px" }}>models</h4>
            <table>
              <tbody>
                {Object.entries(legacy.models).map(([k, v]) => (
                  <tr key={k}>
                    <td><code style={{ fontSize: 10 }}>{k}</code></td>
                    <td style={{ fontFamily: "monospace", fontSize: 11 }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
        {legacy?.intentEngine?.steps ? (
          <>
            <h4 style={{ fontSize: 12, color: "#9aa3b2", margin: "12px 0 4px" }}>intentEngine.steps</h4>
            <table>
              <tbody>
                {legacy.intentEngine.steps.map((s) => (
                  <tr key={s.id}>
                    <td><code style={{ fontSize: 10 }}>{s.id}</code></td>
                    <td style={{ fontSize: 11, color: s.enabled ? "#3fb950" : "#6b7280" }}>{s.enabled ? "enabled" : "disabled"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
        {legacy?.routes ? (
          <>
            <h4 style={{ fontSize: 12, color: "#9aa3b2", margin: "12px 0 4px" }}>routes</h4>
            <table>
              <tbody>
                {legacy.routes.map((r) => (
                  <tr key={r.intent}>
                    <td><code style={{ fontSize: 10 }}>{r.intent}</code></td>
                    <td style={{ fontSize: 11 }}>{r.handler}</td>
                    <td style={{ fontSize: 11, color: r.enabled ? "#3fb950" : "#6b7280" }}>{r.enabled ? "✓" : "✗"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </div>

      {error ? (
        <div style={{ gridColumn: "1 / -1", color: "#da3633", fontSize: 12 }}>
          加载配置失败: {error}
        </div>
      ) : null}
    </div>
  );
}