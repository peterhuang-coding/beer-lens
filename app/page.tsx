import Link from "next/link";
import Nav from "./_components/Nav";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="home-main">
      <Nav active="home" />

      <section className="home-hero">
        <h1>🍺 Beer Lens</h1>
        <p className="home-tagline">
          拍下酒单,找到今晚最值得喝的那杯。
        </p>
        <p className="home-sub">
          浏览器→LLM 路由→8 个 skill 之一的 Harness 聊天流式接口。
        </p>
      </section>

      <section className="home-grid">
        <Link href="/chat" className="home-card">
          <div className="home-card-emoji">💬</div>
          <div className="home-card-title">/chat</div>
          <div className="home-card-desc">
            SSE 流式对话 + 右侧示例验证面板,逐条跑通路由和 skill 调用。
          </div>
          <div className="home-card-arrow">→</div>
        </Link>

        <Link href="/harness" className="home-card">
          <div className="home-card-emoji">🧪</div>
          <div className="home-card-title">/harness</div>
          <div className="home-card-desc">
            8 个 builtin skill 的开关、warm list、意图清单 — 调试路由的入口。
          </div>
          <div className="home-card-arrow">→</div>
        </Link>

        <Link href="/beers" className="home-card">
          <div className="home-card-emoji">🍻</div>
          <div className="home-card-title">/beers</div>
          <div className="home-card-desc">
            浏览本地 beer catalog — 数据源、风格筛选、风味标签。
          </div>
          <div className="home-card-arrow">→</div>
        </Link>

        <Link href="/test-runner" className="home-card">
          <div className="home-card-emoji">▶️</div>
          <div className="home-card-title">/test-runner</div>
          <div className="home-card-desc">
            单条 intent 测试跑通 — 验证规则 + LLM 路由选择。
          </div>
          <div className="home-card-arrow">→</div>
        </Link>
      </section>

      <footer className="home-foot">
        <code>POST /api/chat</code> · SSE stream · LLM {process.env.LLM_MODEL || "LLM_MODEL 未设置"} · 411/411 tests pass
      </footer>

      <style>{`
        .home-main { background:#0f1115; color:#e8eaf0; min-height:100vh;
          font:14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", sans-serif; }
        .home-main * { box-sizing:border-box; }
        .home-hero { padding:60px 40px 28px; max-width:980px; margin:0 auto; text-align:center; }
        .home-hero h1 { margin:0 0 12px; font-size:42px; font-weight:700; }
        .home-tagline { margin:0 0 8px; font-size:18px; color:#e8eaf0; }
        .home-sub { margin:0; font-size:13px; color:#9aa3b2; }
        .home-grid { padding:24px 40px 60px; max-width:980px; margin:0 auto;
          display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:18px; }
        @media (max-width: 720px) { .home-grid { grid-template-columns: 1fr; } }
        .home-card { background:#171a21; border:1px solid #2a2f3a; border-radius:10px;
          padding:22px; text-decoration:none; color:inherit; display:flex; flex-direction:column; gap:8px;
          transition: border-color .15s, transform .15s; }
        .home-card:hover { border-color:#4cb3ff; transform: translateY(-2px); }
        .home-card-emoji { font-size:32px; }
        .home-card-title { font-family:ui-monospace, "SF Mono", Menlo, monospace;
          font-size:14px; color:#f5a524; font-weight:700; }
        .home-card-desc { font-size:12px; color:#9aa3b2; line-height:1.55; }
        .home-card-arrow { font-size:14px; color:#4cb3ff; margin-top:6px; }
        .home-foot { padding:18px 40px 30px; text-align:center; font-size:11px; color:#9aa3b2; }
        .home-foot code { background:#171a21; padding:1px 6px; border-radius:4px; color:#f5a524;
          font-family:ui-monospace, "SF Mono", Menlo, monospace; }
      `}</style>
    </main>
  );
}