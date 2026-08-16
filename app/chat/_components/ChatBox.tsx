"use client";

/**
 * Client-side chat box. Owns message state + SSE fetch loop.
 *
 * The browser sends `POST /api/chat` with `{message}`, parses the
 * `text/event-stream` response, and appends `delta.text` chunks to the
 * most recent assistant bubble until `done` or `error` fires.
 *
 * State is intentionally local — v1 has no conversation history, no
 * persistence, no auth. The chat reloads on every page navigation.
 */

import { useEffect, useRef, useState } from "react";

type Message = { id: string; role: "user" | "assistant"; text: string };

type Meta = { skill_id: string; reason?: string; params?: Record<string, unknown> };

const QUICK_PROMPTS = [
  "推荐一款 NEIPA,ABV 6-7%",
  "我最近喝了一款很苦的 IPA,记一下",
  "什么是拉格?",
  "我其实不喜欢太苦的酒",
];

export default function ChatBox() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "你好,我是 Beer Lens 🍺。挑个话题开始,或者直接打字。",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [status, setStatus] = useState<"idle" | "routing" | "streaming" | "error">("idle");
  const boxRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new content.
  useEffect(() => {
    if (!boxRef.current) return;
    boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [messages]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setStatus("routing");
    setMeta(null);
    const userMsg: Message = { id: `u_${Date.now()}`, role: "user", text: trimmed };
    const assistantId = `a_${Date.now()}`;
    setMessages((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", text: "" }]);
    setInput("");

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
      if (!resp.ok || !resp.body) {
        setStatus("error");
        setBusy(false);
        return;
      }
      setStatus("streaming");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
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
            setMeta(evt.data as Meta);
          } else if (evt.event === "delta" && evt.data) {
            const chunk = (evt.data as { text?: string }).text ?? "";
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + chunk } : m)),
            );
          } else if (evt.event === "error" && evt.data) {
            const errText = `⚠️ ${(evt.data as { message?: string }).message ?? "unknown"}`;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + errText } : m)),
            );
            setStatus("error");
          } else if (evt.event === "done") {
            setStatus("idle");
          }
        }
      }
    } catch (err) {
      setStatus("error");
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, text: `${m.text}\n[网络错误: ${String((err as Error).message ?? err)}]` }
            : m,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-shell">
      <div className="chat-meta">
        <span className={`status status-${status}`}>
          {status === "idle" ? "就绪" : status === "routing" ? "路由中…" : status === "streaming" ? "生成中…" : "错误"}
        </span>
        {meta ? (
          <span className="route">
            skill: <code>{meta.skill_id}</code>
            {meta.reason ? <> · {meta.reason}</> : null}
          </span>
        ) : (
          <span className="route muted">待路由</span>
        )}
      </div>

      <div className="chat-box" ref={boxRef}>
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            <div className="role">{m.role === "user" ? "你" : "Beer Lens"}</div>
            <div className="text">{m.text || (m.role === "assistant" ? "…" : "")}</div>
          </div>
        ))}
      </div>

      <div className="quick-row">
        {QUICK_PROMPTS.map((p) => (
          <button key={p} disabled={busy} onClick={() => send(p)}>
            {p}
          </button>
        ))}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="说点什么吧… (Enter 发送)"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          {busy ? "等待…" : "发送"}
        </button>
      </form>

      <style jsx>{`
        .chat-shell { display:flex; flex-direction:column; gap:12px; height: 70vh; }
        .chat-meta { display:flex; gap:12px; align-items:center; font-size:12px; color:#9aa3b2; }
        .status { padding:2px 8px; border-radius:999px; font-weight:600; letter-spacing:0.4px; text-transform:uppercase; }
        .status-idle { background:#1e3a8a; color:#bfdbfe; }
        .status-routing, .status-streaming { background:#166534; color:#d1fae5; }
        .status-error { background:#7f1d1d; color:#fee2e2; }
        .route code { background:#171a21; padding:1px 6px; border-radius:4px; color:#f5a524; }
        .route.muted { color:#6b7280; font-style:italic; }
        .chat-box { flex:1; overflow-y:auto; background:#0f1115; border:1px solid #2a2f3a; border-radius:8px; padding:14px; display:flex; flex-direction:column; gap:10px; }
        .bubble { padding:10px 12px; border-radius:8px; max-width:85%; white-space:pre-wrap; line-height:1.55; }
        .bubble.user { align-self:flex-end; background:#1e3a8a; color:#dbeafe; }
        .bubble.assistant { align-self:flex-start; background:#1f232c; color:#e8eaf0; border:1px solid #2a2f3a; }
        .bubble .role { font-size:10px; text-transform:uppercase; color:#9aa3b2; margin-bottom:4px; letter-spacing:0.5px; font-weight:600; }
        .quick-row { display:flex; gap:6px; flex-wrap:wrap; }
        .quick-row button { background:#171a21; color:#9aa3b2; border:1px solid #2a2f3a; border-radius:6px; padding:4px 10px; font-size:11px; cursor:pointer; }
        .quick-row button:hover:not(:disabled) { background:#1f232c; color:#e8eaf0; }
        .quick-row button:disabled { opacity:0.5; cursor:not-allowed; }
        .chat-input { display:flex; gap:8px; }
        .chat-input input { flex:1; background:#0f1115; color:#e8eaf0; border:1px solid #2a2f3a; border-radius:8px; padding:10px 12px; font-size:13px; outline:none; }
        .chat-input input:focus { border-color:#4cb3ff; }
        .chat-input button { background:#4cb3ff; color:#0f1115; border:none; border-radius:8px; padding:0 16px; font-weight:600; cursor:pointer; }
        .chat-input button:disabled { background:#374151; color:#9aa3b2; cursor:not-allowed; }
      `}</style>
    </div>
  );
}

interface ParsedSSE {
  event: string;
  data: unknown;
}

function parseSSERecord(record: string): ParsedSSE | null {
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