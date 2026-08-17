"use client";

/**
 * Client-side chat box. Owns message state + SSE fetch loop.
 *
 * The browser sends `POST /api/chat` with `{message}`, parses the
 * `text/event-stream` response, and:
 *   - appends `delta.text` chunks to the most recent assistant bubble
 *   - renders `result.candidates` as beer cards (labelImage + brewery + score)
 *   - renders `result.menuImage` as a "酒单" header illustration
 *
 * State is intentionally local — v1 has no conversation history, no
 * persistence, no auth. The chat reloads on every page navigation.
 */

import { useEffect, useRef, useState } from "react";

type Message = { id: string; role: "user" | "assistant"; text: string };

type Meta = { skill_id: string; reason?: string; params?: Record<string, unknown> };

type BeerCard = {
  candidateId: string;
  menuIndex?: number;
  displayName: string;
  brewery?: string;
  style?: string;
  abv?: number | null;
  untappdScore?: number | null;
  untappdRatingCount?: number | null;
  untappdUrl?: string | null;
  labelImage?: string | null;
  worthScore?: number;
  fitScore?: number;
  reason?: string;
};

type Picks = {
  topPick?: { candidateId?: string; label?: string; reason?: string };
  safePick?: { candidateId?: string; label?: string; reason?: string };
  explorePick?: { candidateId?: string; label?: string; reason?: string };
  avoidOrCaution?: { candidateId?: string; label?: string; reason?: string };
};

type ResultPayload = {
  skill_id?: string;
  reply?: string;
  candidates?: BeerCard[];
  picks?: Picks;
  profileSummary?: string;
  menuImage?: string;
  hasLabels?: boolean;
};

const QUICK_PROMPTS = [
  "推荐一款 Stout",
  "我想喝点不苦的拉格",
  "推荐一款 NEIPA",
  "什么是 NEIPA?",
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
  const [results, setResults] = useState<Record<string, ResultPayload>>({});
  const boxRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new content.
  useEffect(() => {
    if (!boxRef.current) return;
    boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [messages, results]);

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
          } else if (evt.event === "result" && evt.data) {
            setResults((prev) => ({ ...prev, [assistantId]: evt.data as ResultPayload }));
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
            {m.role === "assistant" && results[m.id] ? (
              <BeerResultView result={results[m.id]} />
            ) : null}
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
        .bubble { padding:10px 12px; border-radius:8px; max-width:92%; white-space:pre-wrap; line-height:1.55; }
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

// ── Beer result rendering ─────────────────────────────────────────────────

function BeerResultView({ result }: { result: ResultPayload }) {
  const candidates = result.candidates ?? [];
  const picks = result.picks ?? {};
  const menuImage = result.menuImage;
  const hasLabels = result.hasLabels ?? candidates.some((c) => c.labelImage);

  return (
    <div className="beer-result">
      {menuImage ? (
        <a className="menu-img" href={menuImage} target="_blank" rel="noreferrer">
          <img src={menuImage} alt="酒单示意" loading="lazy" />
          <span className="menu-img-cap">📋 现场酒单(参考)</span>
        </a>
      ) : null}

      {Object.keys(picks).length > 0 ? (
        <div className="picks">
          {(["topPick", "safePick", "explorePick", "avoidOrCaution"] as const).map((k) => {
            const p = picks[k];
            if (!p || !p.label) return null;
            const cls = k === "avoidOrCaution" ? "avoid" : k === "safePick" ? "safe" : k === "explorePick" ? "explore" : "top";
            return (
              <span key={k} className={`pick pick-${cls}`}>
                <b>{p.label}</b>
                {p.reason ? <small>{p.reason}</small> : null}
              </span>
            );
          })}
        </div>
      ) : null}

      {candidates.length > 0 ? (
        <div className="cards">
          {candidates.map((c) => (
            <BeerCardView key={c.candidateId || c.displayName} c={c} />
          ))}
        </div>
      ) : (
        <div className="no-data">
          <small>本次查询没有匹配的本地啤酒数据{hasLabels ? "" : " · 上方酒单图作为参考"}</small>
        </div>
      )}

      <style jsx>{`
        .beer-result { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
        .menu-img { display:block; border-radius:6px; overflow:hidden; border:1px solid #2a2f3a; background:#0f1115; position:relative; }
        .menu-img img { width:100%; height:auto; display:block; opacity:0.92; }
        .menu-img-cap { position:absolute; bottom:6px; left:8px; background:rgba(15,17,21,0.85); color:#f5a524; font-size:10px; padding:2px 8px; border-radius:4px; font-weight:600; }
        .picks { display:flex; gap:4px; flex-wrap:wrap; }
        .pick { font-size:10px; padding:3px 8px; border-radius:999px; display:inline-flex; align-items:center; gap:4px; }
        .pick b { font-weight:700; }
        .pick small { opacity:0.85; }
        .pick-top { background:#166534; color:#d1fae5; }
        .pick-safe { background:#1e3a8a; color:#bfdbfe; }
        .pick-explore { background:#7c2d12; color:#fed7aa; }
        .pick-avoid { background:#7f1d1d; color:#fee2e2; }
        .cards { display:grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap:8px; }
        .no-data { color:#9aa3b2; font-size:11px; padding:6px 0; }
      `}</style>
    </div>
  );
}

function BeerCardView({ c }: { c: BeerCard }) {
  return (
    <a
      className="bcard"
      href={c.untappdUrl ?? "#"}
      target={c.untappdUrl ? "_blank" : undefined}
      rel="noreferrer"
    >
      <div className="bcard-img">
        {c.labelImage ? (
          <img src={c.labelImage} alt={c.displayName} loading="lazy" />
        ) : (
          <span className="bcard-img-fallback">🍺</span>
        )}
      </div>
      <div className="bcard-body">
        <div className="bcard-name" title={c.displayName}>{c.displayName}</div>
        <div className="bcard-brew">{c.brewery ?? ""}</div>
        <div className="bcard-meta">
          {c.style ? <span>{c.style}</span> : null}
          {c.abv ? <span className="abv">ABV {c.abv}%</span> : null}
        </div>
        {typeof c.untappdScore === "number" && c.untappdScore > 0 ? (
          <div className="bcard-score">⭐ {c.untappdScore.toFixed(2)}
            {c.untappdRatingCount ? <small> · {c.untappdRatingCount.toLocaleString()}</small> : null}
          </div>
        ) : null}
      </div>
      <style jsx>{`
        .bcard { background:#0f1115; border:1px solid #2a2f3a; border-radius:6px; overflow:hidden;
          text-decoration:none; color:inherit; display:flex; flex-direction:column;
          transition: border-color .12s, transform .12s; }
        .bcard:hover { border-color:#4cb3ff; transform: translateY(-1px); }
        .bcard-img { width:100%; aspect-ratio: 1/1; background:#171a21; display:flex; align-items:center; justify-content:center; overflow:hidden; }
        .bcard-img img { width:100%; height:100%; object-fit:cover; }
        .bcard-img-fallback { font-size:32px; opacity:0.5; }
        .bcard-body { padding:6px 8px; display:flex; flex-direction:column; gap:2px; min-width:0; }
        .bcard-name { font-size:11px; font-weight:600; color:#e8eaf0; line-height:1.25;
          overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
        .bcard-brew { font-size:9px; color:#9aa3b2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .bcard-meta { font-size:9px; color:#9aa3b2; display:flex; gap:6px; flex-wrap:wrap; }
        .bcard-meta .abv { color:#f5a524; }
        .bcard-score { font-size:10px; color:#f5a524; margin-top:2px; font-weight:600; }
        .bcard-score small { color:#9aa3b2; font-weight:400; }
      `}</style>
    </a>
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