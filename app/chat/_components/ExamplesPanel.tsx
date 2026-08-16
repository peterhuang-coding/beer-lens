"use client";

/**
 * ExamplesPanel — right-side verification harness.
 *
 * Lists a curated set of example queries that exercise different skills
 * and routes. Clicking "▶ 运行" sends the query through POST /api/chat
 * and renders the resulting skill_id + streamed reply underneath the
 * card so the user can verify each route end-to-end without polluting
 * the main chat stream.
 *
 * State is local to each card — multiple examples can be run in parallel
 * without interfering with the left-side ChatBox.
 */

import { useState } from "react";

interface ExampleDef {
  id: string;
  emoji: string;
  category: string;
  title: string;
  query: string;
  /** Expected skill id for verification hint shown in the card. */
  expectSkill: string;
}

const EXAMPLES: ExampleDef[] = [
  {
    id: "rec-neipa",
    emoji: "🍺",
    category: "推荐",
    title: "推荐一款 NEIPA",
    query: "推荐一款 NEIPA,ABV 6-7%",
    expectSkill: "menu_recommend",
  },
  {
    id: "rec-stout",
    emoji: "🍻",
    category: "推荐",
    title: "想要浓郁的世涛",
    query: "我想喝一款味道浓郁的世涛",
    expectSkill: "menu_recommend",
  },
  {
    id: "know-neipa",
    emoji: "📚",
    category: "知识",
    title: "NEIPA 是什么",
    query: "什么是 NEIPA?和普通 IPA 有什么区别?",
    expectSkill: "beer_knowledge",
  },
  {
    id: "feedback-bitter",
    emoji: "✏️",
    category: "反馈",
    title: "记一下苦 IPA",
    query: "刚喝了一款很苦的 IPA,记一下",
    expectSkill: "tasting_feedback",
  },
  {
    id: "memory-fix",
    emoji: "🚫",
    category: "更正",
    title: "改一下偏好",
    query: "我其实不喜欢太苦的酒",
    expectSkill: "memory_correction",
  },
  {
    id: "profile-like",
    emoji: "👤",
    category: "画像",
    title: "我喜欢什么",
    query: "我喜欢什么风格的啤酒?",
    expectSkill: "profile_query",
  },
];

type RunState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; skillId: string; reason: string; reply: string; latencyMs: number }
  | { phase: "error"; code: string; message: string };

export default function ExamplesPanel() {
  return (
    <aside className="examples-panel">
      <div className="examples-head">
        <h3>示例 & 验证</h3>
        <p className="examples-sub">
          点击「▶ 运行」逐条验证路由 + skill 调用的实际效果。
        </p>
      </div>
      <div className="examples-list">
        {EXAMPLES.map((ex) => (
          <ExampleCard key={ex.id} def={ex} />
        ))}
      </div>
      <style jsx>{`
        .examples-panel { background:#171a21; border:1px solid #2a2f3a; border-radius:10px; padding:18px; height: 100%; overflow-y:auto; }
        .examples-head h3 { margin:0 0 4px; font-size:14px; color:#f5a524; font-weight:600; }
        .examples-sub { margin:0 0 14px; color:#9aa3b2; font-size:11px; line-height:1.45; }
        .examples-list { display:flex; flex-direction:column; gap:12px; }
      `}</style>
    </aside>
  );
}

function ExampleCard({ def }: { def: ExampleDef }) {
  const [run, setRun] = useState<RunState>({ phase: "idle" });

  async function execute() {
    setRun({ phase: "running" });
    const t0 = Date.now();
    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: def.query }),
      });
      if (!resp.ok || !resp.body) {
        setRun({ phase: "error", code: `http_${resp.status}`, message: "no body" });
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let skillId = "unknown";
      let reason = "";
      let reply = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const records = buf.split("\n\n");
        buf = records.pop() ?? "";
        for (const rec of records) {
          const evt = parseSSERecord(rec);
          if (!evt) continue;
          if (evt.event === "meta" && evt.data) {
            const m = evt.data as { skill_id?: string; reason?: string };
            skillId = m.skill_id ?? "unknown";
            reason = m.reason ?? "";
          } else if (evt.event === "delta" && evt.data) {
            reply += ((evt.data as { text?: string }).text ?? "");
          } else if (evt.event === "error" && evt.data) {
            const e = evt.data as { code?: string; message?: string };
            setRun({
              phase: "error",
              code: e.code ?? "internal",
              message: e.message ?? "",
            });
            return;
          }
        }
      }
      setRun({
        phase: "done",
        skillId,
        reason,
        reply: reply || "(空)",
        latencyMs: Date.now() - t0,
      });
    } catch (err) {
      setRun({
        phase: "error",
        code: "network",
        message: String((err as Error).message ?? err),
      });
    }
  }

  const matched =
    run.phase === "done" && run.skillId === def.expectSkill;
  const mismatch =
    run.phase === "done" && run.skillId !== def.expectSkill && run.skillId !== "none";

  return (
    <div className="ex-card">
      <div className="ex-card-head">
        <span className="ex-emoji">{def.emoji}</span>
        <div className="ex-meta">
          <div className="ex-cat">{def.category}</div>
          <div className="ex-title">{def.title}</div>
        </div>
        <button
          className="ex-run"
          onClick={execute}
          disabled={run.phase === "running"}
        >
          {run.phase === "running" ? "..." : "▶ 运行"}
        </button>
      </div>
      <div className="ex-query">"{def.query}"</div>
      <div className="ex-expect">期望: <code>{def.expectSkill}</code></div>

      {run.phase === "done" ? (
        <div className={`ex-result ${matched ? "ok" : mismatch ? "bad" : ""}`}>
          <div className="ex-row">
            <span className="ex-tag">skill</span>
            <code className={matched ? "ex-skill-ok" : "ex-skill-bad"}>
              {run.skillId}
            </code>
            <span className="ex-latency">{run.latencyMs}ms</span>
          </div>
          {run.reason ? (
            <div className="ex-row ex-reason">↳ {run.reason}</div>
          ) : null}
          <div className="ex-reply">{run.reply}</div>
        </div>
      ) : null}
      {run.phase === "error" ? (
        <div className="ex-result bad">
          <div className="ex-row">
            <span className="ex-tag error">{run.code}</span>
          </div>
          <div className="ex-reply">{run.message}</div>
        </div>
      ) : null}
      {run.phase === "running" ? (
        <div className="ex-result pending">
          <div className="ex-row"><span className="ex-tag pending">路由 + skill 调用中…</span></div>
        </div>
      ) : null}

      <style jsx>{`
        .ex-card { background:#0f1115; border:1px solid #2a2f3a; border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:8px; }
        .ex-card-head { display:flex; align-items:center; gap:10px; }
        .ex-emoji { font-size:24px; line-height:1; }
        .ex-meta { flex:1; min-width:0; }
        .ex-cat { font-size:9px; color:#9aa3b2; text-transform:uppercase; letter-spacing:0.6px; font-weight:600; }
        .ex-title { font-size:13px; color:#e8eaf0; font-weight:600; margin-top:2px; }
        .ex-run { background:#4cb3ff; color:#0f1115; border:none; border-radius:6px; padding:4px 10px; font-size:11px; font-weight:700; cursor:pointer; }
        .ex-run:disabled { background:#374151; color:#9aa3b2; cursor:wait; }
        .ex-run:hover:not(:disabled) { background:#38a3ee; }
        .ex-query { font-size:11px; color:#9aa3b2; font-style:italic; line-height:1.5; padding:6px 8px; background:#171a21; border-radius:4px; }
        .ex-expect { font-size:10px; color:#9aa3b2; }
        .ex-expect code { background:#171a21; padding:1px 6px; border-radius:4px; color:#f5a524; }
        .ex-result { padding:8px 10px; border-radius:6px; border:1px solid #2a2f3a; background:#171a21; display:flex; flex-direction:column; gap:4px; font-size:11px; }
        .ex-result.ok { border-color:#15803d; background:#052e16; }
        .ex-result.bad { border-color:#7f1d1d; background:#450a0a; }
        .ex-result.pending { border-color:#1e3a8a; background:#0c1f3f; }
        .ex-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .ex-reason { color:#9aa3b2; font-size:10px; }
        .ex-tag { background:#1f232c; color:#9aa3b2; padding:1px 6px; border-radius:4px; font-size:9px; font-weight:600; text-transform:uppercase; letter-spacing:0.4px; }
        .ex-tag.error { background:#7f1d1d; color:#fee2e2; }
        .ex-tag.pending { background:#1e3a8a; color:#bfdbfe; }
        .ex-skill-ok { background:#15803d; color:#d1fae5; padding:1px 6px; border-radius:4px; font-size:10px; font-weight:700; }
        .ex-skill-bad { background:#7f1d1d; color:#fee2e2; padding:1px 6px; border-radius:4px; font-size:10px; font-weight:700; }
        .ex-latency { color:#9aa3b2; font-size:10px; margin-left:auto; }
        .ex-reply { color:#e8eaf0; font-size:11px; line-height:1.55; white-space:pre-wrap; padding:6px 0 0; border-top:1px dashed #2a2f3a; }
      `}</style>
    </div>
  );
}

function parseSSERecord(record: string): { event: string; data: unknown } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of record.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}