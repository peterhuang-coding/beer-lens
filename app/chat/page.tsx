import Link from "next/link";
import ChatBox from "./_components/ChatBox";
import ExamplesPanel from "./_components/ExamplesPanel";

export const dynamic = "force-dynamic";

export default function ChatPage() {
  return (
    <main className="chat-main">
      <style>{`
        .chat-main { background:#0f1115; color:#e8eaf0; min-height:100vh;
          font:14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", sans-serif; }
        .chat-main * { box-sizing:border-box; }
        .top-nav { padding:14px 40px; background:#1f232c; border-bottom:1px solid #2a2f3a;
          display:flex; gap:18px; align-items:center; }
        .top-nav a { color:#4cb3ff; text-decoration:none; font-size:13px; font-weight:500;
          padding:4px 10px; border-radius:6px; }
        .top-nav a:hover { background:#2a2f3a; }
        .top-nav a.active { background:#2a2f3a; color:#f5a524; }
        .top-nav .nav-spacer { flex:1; }
        .top-nav .nav-head { font-family:ui-monospace, "SF Mono", Menlo, monospace;
          font-size:11px; color:#9aa3b2; }
        .chat-header { padding:28px 40px 18px; border-bottom:1px solid #2a2f3a; }
        .chat-header h1 { margin:0 0 6px; font-size:22px; font-weight:600; }
        .chat-meta { color:#9aa3b2; font-size:12px; }
        .chat-meta code { background:#171a21; padding:1px 6px; border-radius:4px; color:#f5a524; }
        .chat-content { padding:24px 40px 60px; max-width:1280px; margin:0 auto; display:grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap:24px; align-items:start; }
        @media (max-width: 900px) { .chat-content { grid-template-columns: 1fr; } }
        .chat-main-col { display:flex; flex-direction:column; gap:14px; min-width:0; }
        .chat-legend { background:#171a21; border:1px solid #2a2f3a; border-radius:8px; padding:14px 16px; color:#9aa3b2; font-size:12px; }
        .chat-legend code { background:#0f1115; padding:1px 6px; border-radius:4px; color:#f5a524; }
        .chat-legend b { color:#e8eaf0; }
        .chat-side-col { position:sticky; top:14px; max-height: calc(100vh - 28px); min-width:0; }
      `}</style>

      <nav className="top-nav">
        <span className="nav-head">🍺 Beer Lens</span>
        <Link href="/harness">/harness</Link>
        <Link href="/beers">/beers</Link>
        <Link href="/chat" className="active">/chat</Link>
        <span className="nav-spacer" />
        <span className="nav-head">LLM · Ark · doubao-seed-evolving</span>
      </nav>

      <header className="chat-header">
        <h1>💬 Beer Lens Chat</h1>
        <div className="chat-meta">
          POST <code>/api/chat</code> · SSE stream · LLM routes to 8 builtin skills
        </div>
      </header>

      <div className="chat-content">
        <div className="chat-main-col">
          <div className="chat-legend">
            <b>使用说明</b>:浏览器发送 <code>message</code>,harness 经 LLM 路由 → invoke 8 个 skill 之一 →
            流式返回。每条消息上方 <code>skill_id</code> 是 LLM 选中的目标;若路由失败会显示 <code>error</code> 事件。
          </div>
          <ChatBox />
        </div>
        <div className="chat-side-col">
          <ExamplesPanel />
        </div>
      </div>
    </main>
  );
}