import { readFile } from "node:fs/promises";
import Link from "next/link";

// ── Types ──────────────────────────────────────────────────────────────────

type Stats = {
  total_records: number;
  by_country: Array<{ country: string; count: number }>;
  by_style_top_50: Array<{ style: string; count: number }>;
  rating_distribution: Record<string, number>;
  brewery_unique: number;
  abv_distribution: { mean: number; median: number; min: number; max: number; n: number };
  generated_at: string;
};

type Source = {
  file: string;
  generatedAt: string;
  totalRows: number;
};

// ── Data loading (server-side) ─────────────────────────────────────────────

async function loadStats(): Promise<Stats | null> {
  try {
    const txt = await readFile("data/raw-data/untappd-csv-stats.json", "utf8");
    return JSON.parse(txt) as Stats;
  } catch {
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

const PLACEHOLDER_STYLES = new Set([
  "This beer is no longer being produced by the brewery",
]);

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(2)}%`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtAbv(n: number): string {
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "—";
}

// ── Page (server component) ────────────────────────────────────────────────

export const dynamic = "force-dynamic";

export default async function BeersPage() {
  const stats = await loadStats();
  const source: Source = {
    file: "data/raw-data/untappd-csv-stats.json",
    generatedAt: stats?.generated_at ?? "unknown",
    totalRows: stats?.total_records ?? 0,
  };
  const generatedAtDisplay = source.generatedAt.slice(0, 19).replace("T", " ");

  // Derived: filter placeholder styles from "by_style_top_50" so the bar chart
  // shows real styles. (Placeholder 占 8360 行会压扁其他。)
  const stylesClean = (stats?.by_style_top_50 ?? []).filter(
    (s) => !PLACEHOLDER_STYLES.has(s.style),
  );
  const styleMaxCount = stylesClean.reduce((m, s) => Math.max(m, s.count), 0);

  // Rating distribution: convert object to sorted array.
  const ratingBins = Object.entries(stats?.rating_distribution ?? {})
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const ratingMax = ratingBins.reduce((m, b) => Math.max(m, b.count), 0);
  const ratingTotal = ratingBins.reduce((s, b) => s + b.count, 0);

  const countries = stats?.by_country ?? [];
  const countryMax = countries.reduce((m, c) => Math.max(m, c.count), 0);
  const countryTotal = countries.reduce((s, c) => s + c.count, 0);

  return (
    <main className="beers-main">
      <style>{`
        .beers-main { background: #0f1115; color: #e8eaf0; min-height: 100vh;
          font: 14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", sans-serif; }
        .beers-main * { box-sizing: border-box; }
        .top-nav { padding: 14px 40px; background: #1f232c; border-bottom: 1px solid #2a2f3a;
          display: flex; gap: 18px; align-items: center; }
        .top-nav a { color: #4cb3ff; text-decoration: none; font-size: 13px; font-weight: 500;
          padding: 4px 10px; border-radius: 6px; }
        .top-nav a:hover { background: #2a2f3a; }
        .top-nav a.active { background: #2a2f3a; color: #f5a524; }
        .top-nav .nav-spacer { flex: 1; }
        .top-nav .nav-head { font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 11px; color: #9aa3b2; }
        .beers-header { padding: 28px 40px 18px; border-bottom: 1px solid #2a2f3a; }
        .beers-header h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; }
        .beers-meta { color: #9aa3b2; font-size: 12px; }
        .beers-meta code { background: #171a21; padding: 1px 6px; border-radius: 4px; color: #f5a524; }
        .beers-meta b { color: #e8eaf0; font-weight: 600; }
        .beers-content { padding: 28px 40px 60px; display: grid; gap: 32px; max-width: 1200px; margin: 0 auto; }
        .beers-block { background: #171a21; border: 1px solid #2a2f3a; border-radius: 10px; overflow: hidden; }
        .beers-block-head { padding: 18px 24px; background: #1f232c; border-bottom: 1px solid #2a2f3a;
          display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
        .beers-block-head h2 { margin: 0; font-size: 16px; font-weight: 600; color: #f5a524; }
        .beers-block-head .sub { color: #9aa3b2; font-size: 12px; }
        .beers-block-head .counts { margin-left: auto; color: #9aa3b2; font-size: 12px; }
        .beers-block-head .counts b { color: #e8eaf0; font-weight: 600; }
        .bar-row { padding: 10px 24px; display: grid; grid-template-columns: 180px 1fr 90px; align-items: center; gap: 14px;
          border-bottom: 1px solid #2a2f3a; font-size: 13px; }
        .bar-row:last-child { border-bottom: none; }
        .bar-row .label { color: #e8eaf0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bar-row .label.placeholder { color: #9aa3b2; font-style: italic; }
        .bar-track { background: #0f1115; border: 1px solid #2a2f3a; border-radius: 4px; height: 18px;
          position: relative; overflow: hidden; }
        .bar-fill { background: linear-gradient(90deg, #4cb3ff, #f5a524); height: 100%;
          border-radius: 3px 0 0 3px; min-width: 2px; transition: width 0.2s; }
        .bar-row .count { color: #9aa3b2; font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 12px; text-align: right; }
        .bar-row .count b { color: #e8eaf0; font-weight: 600; }
        .bar-row .count .pct { color: #6b7280; font-size: 11px; margin-left: 4px; }
        .summary-grid { padding: 20px 24px; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
        .summary-card { background: #0f1115; border: 1px solid #2a2f3a; border-radius: 8px; padding: 14px 16px; }
        .summary-card .k { color: #9aa3b2; font-size: 11px; text-transform: uppercase;
          letter-spacing: 0.5px; margin-bottom: 6px; }
        .summary-card .v { color: #f5a524; font-size: 22px; font-weight: 600;
          font-family: ui-monospace, "SF Mono", Menlo, monospace; }
        .summary-card .u { color: #9aa3b2; font-size: 11px; margin-left: 4px; font-weight: 400; }
        .summary-card .note { color: #6b7280; font-size: 10px; margin-top: 4px; font-style: italic; }
        .missing { padding: 60px 40px; text-align: center; color: #9aa3b2; font-size: 14px; }
        .missing code { background: #171a21; padding: 2px 8px; border-radius: 4px; color: #f5a524; }
        .block-legend { padding: 14px 24px; color: #9aa3b2; font-size: 12px; background: #1f232c; border-top: 1px solid #2a2f3a; }
        .block-legend code { color: #f5a524; }
      `}</style>

      <nav className="top-nav">
        <span className="nav-head">🍺 Beer Lens</span>
        <Link href="/harness">/harness</Link>
        <Link href="/beers" className="active">/beers</Link>
        <span className="nav-spacer" />
        <span className="nav-head">data viz · Untappd CSV</span>
      </nav>

      <header className="beers-header">
        <h1>🍻 Untappd 啤酒数据可视化</h1>
        <div className="beers-meta">
          数据源 <code>{source.file}</code> · 生成于 <code>{generatedAtDisplay}</code> ·
          {" "}<b>{fmtNum(source.totalRows)}</b> 条记录 ·
          {" "}<b>{fmtNum(stats?.brewery_unique ?? 0)}</b> 个 brewery
        </div>
      </header>

      {stats === null ? (
        <div className="missing">
          找不到 <code>data/raw-data/untappd-csv-stats.json</code>。
          先跑 <code>npm run import-untappd-csv</code> 生成 stats。
        </div>
      ) : (
        <div className="beers-content">

          {/* 1. 国家分布 ──────────────────────────────────────────────── */}
          <section className="beers-block">
            <div className="beers-block-head">
              <h2>1. 国家分布</h2>
              <span className="sub">{countries.length} 个国家</span>
              <span className="counts">合计 <b>{fmtNum(countryTotal)}</b> 条</span>
            </div>
            {countries.map((c) => (
              <div key={c.country} className="bar-row">
                <div className="label">{c.country}</div>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ width: `${(c.count / countryMax) * 100}%` }}
                  />
                </div>
                <div className="count">
                  <b>{fmtNum(c.count)}</b>
                  <span className="pct">{pct(c.count, countryTotal)}</span>
                </div>
              </div>
            ))}
            <div className="block-legend">
              注:本数据集只覆盖英伦三岛 + 澳新 + 日荷 — 源 CSV 不含中国大陆/美国。
            </div>
          </section>

          {/* 2. 风格 Top 20 (排除 placeholder) ──────────────────────────── */}
          <section className="beers-block">
            <div className="beers-block-head">
              <h2>2. 风格 Top {Math.min(20, stylesClean.length)}</h2>
              <span className="sub">已过滤 placeholder "{[...PLACEHOLDER_STYLES][0]}" (8,360 条)</span>
              <span className="counts">前 <b>{Math.min(20, stylesClean.length)}</b> / <b>{stylesClean.length}</b></span>
            </div>
            {stylesClean.slice(0, 20).map((s) => (
              <div key={s.style} className="bar-row">
                <div className="label">{s.style}</div>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ width: `${(s.count / styleMaxCount) * 100}%` }}
                  />
                </div>
                <div className="count">
                  <b>{fmtNum(s.count)}</b>
                </div>
              </div>
            ))}
            <div className="block-legend">
              placeholder "{[...PLACEHOLDER_STYLES][0]}" 占 8360 条(25.5%),压扁真实风格分布,故剔除后展示。
            </div>
          </section>

          {/* 3. Rating 分布 ───────────────────────────────────────────── */}
          <section className="beers-block">
            <div className="beers-block-head">
              <h2>3. 评分分布</h2>
              <span className="sub">Untappd 0-5 评分</span>
              <span className="counts">合计 <b>{fmtNum(ratingTotal)}</b> 条</span>
            </div>
            {ratingBins.map((b) => (
              <div key={b.label} className="bar-row">
                <div className="label">{b.label}</div>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{
                      width: ratingMax > 0 ? `${(b.count / ratingMax) * 100}%` : "0%",
                    }}
                  />
                </div>
                <div className="count">
                  <b>{fmtNum(b.count)}</b>
                  <span className="pct">{ratingTotal > 0 ? pct(b.count, ratingTotal) : "—"}</span>
                </div>
              </div>
            ))}
            <div className="block-legend">
              评分集中在 3.5-4(77%) — 与 Untappd 用户打分偏正向的社区习惯一致。
            </div>
          </section>

          {/* 4. ABV 摘要 ─────────────────────────────────────────────── */}
          <section className="beers-block">
            <div className="beers-block-head">
              <h2>4. ABV (酒精度) 摘要</h2>
              <span className="sub">基于 {fmtNum(stats.abv_distribution.n)} 条有效记录</span>
            </div>
            <div className="summary-grid">
              <div className="summary-card">
                <div className="k">均值 mean</div>
                <div className="v">
                  {fmtAbv(stats.abv_distribution.mean)}
                </div>
              </div>
              <div className="summary-card">
                <div className="k">中位数 median</div>
                <div className="v">
                  {fmtAbv(stats.abv_distribution.median)}
                </div>
              </div>
              <div className="summary-card">
                <div className="k">最小值 min</div>
                <div className="v">
                  {fmtAbv(stats.abv_distribution.min)}
                </div>
              </div>
              <div className="summary-card">
                <div className="k">最大值 max</div>
                <div className="v">
                  {fmtAbv(stats.abv_distribution.max)}
                </div>
                <div className="note">可能含数据错误(75% 异常高)</div>
              </div>
              <div className="summary-card">
                <div className="k">有效记录</div>
                <div className="v">{fmtNum(stats.abv_distribution.n)}</div>
                <div className="note">
                  {fmtNum(stats.total_records - stats.abv_distribution.n)} 条 ABV 缺失
                </div>
              </div>
              <div className="summary-card">
                <div className="k">独立 brewery</div>
                <div className="v">{fmtNum(stats.brewery_unique)}</div>
              </div>
            </div>
          </section>

        </div>
      )}
    </main>
  );
}
