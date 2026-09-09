/* Local dashboard: render external data only as text, never as HTML. */
const $ = (s) => document.querySelector(s);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
async function get(url) {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
function kpis(target, items) {
  $(target).replaceChildren(
    ...items.map(([label, value]) => {
      const node = el("div", null, "kpi");
      node.append(el("div", label, "label"), el("div", value ?? "—", "value"));
      return node;
    }),
  );
}
function card(title, body, state) {
  const node = el("div", null, "card");
  node.append(el("div", title, "title"), el("div", body, "body"));
  if (state) node.append(el("div", state, "state"));
  return node;
}
function emptyRow(message) {
  const row = el("tr");
  const cell = el("td", message, "empty");
  cell.colSpan = 8;
  row.append(cell);
  return row;
}
async function renderLog() {
  try {
    const logs = await get("/api/crawl-log");
    kpis("#crawl-summary", [
      ["日志条数", logs.length],
      ["已验证", logs.filter((x) => x.status === "verified").length],
      ["跳过", logs.filter((x) => x.status === "skipped").length],
      ["失败", logs.filter((x) => x.status === "failed").length],
    ]);
    $("#crawl-tbody").replaceChildren(
      ...(logs.length
        ? logs
            .slice(-50)
            .reverse()
            .map((log) => {
              const row = el("tr");
              for (const value of [
                log.ts ?? log.crawledAt,
                log.round,
                log.target?.name ?? log.name,
                log.target?.brewery ?? log.brewery,
                log.status,
                log.abv,
                log.rating,
                Array.isArray(log.sources)
                  ? log.sources.join(", ")
                  : log.source_platform,
              ])
                row.append(el("td", value ?? "—"));
              return row;
            })
        : [
            emptyRow(
              "还没有采集日志。生成目标清单后，完成真实采集再记录结果。",
            ),
          ]),
    );
  } catch (error) {
    $("#crawl-tbody").replaceChildren(emptyRow(error.message));
  }
}
function chart(series) {
  const canvas = $("#db-chart"),
    ctx = canvas.getContext("2d");
  const width = (canvas.width = 900),
    height = (canvas.height = 220);
  ctx.clearRect(0, 0, width, height);
  ctx.font = "14px sans-serif";
  ctx.fillStyle = "#8b949e";
  if (!series.length) {
    ctx.fillText("暂无历史快照", 30, 40);
    return;
  }
  const max = Math.max(...series.map((x) => x.total), 1);
  const points = series.map((s, i) => ({
    x: 60 + (series.length === 1 ? 0 : i / (series.length - 1)) * (width - 120),
    y: height - 45 - (s.total / max) * (height - 85),
    ...s,
  }));
  ctx.strokeStyle = "#3fb950";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
  for (const [i, p] of points.entries()) {
    ctx.fillStyle = "#3fb950";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
    ctx.fill();
    if (i === 0 || i === points.length - 1) {
      ctx.fillStyle = "#8b949e";
      ctx.fillText(p.date, p.x - 35, height - 15);
      ctx.fillText(String(p.total), p.x - 10, p.y - 10);
    }
  }
  canvas.setAttribute(
    "aria-label",
    series.map((s) => `${s.date}: ${s.total} 款`).join("; "),
  );
}
async function renderStats() {
  try {
    const stats = await get("/api/stats");
    kpis("#db-kpis", [
      ["种子啤酒", stats.total_beers],
      ["酒厂", stats.total_breweries],
      ["平均快照评分", stats.avg_rating?.toFixed(2)],
      ["缺少 ABV", stats.missing_abv],
      ["缺少评分", stats.missing_rating],
    ]);
    const snapshots = await get("/api/snapshots");
    chart(snapshots);
    $("#snapshot-values").replaceChildren(
      ...(snapshots.length
        ? snapshots.map((s) =>
            el(
              "li",
              `${s.date}：${s.total} 款，已验证 ${s.verified ?? "未知"}`,
            ),
          )
        : [el("li", "没有历史快照；不会用零值代替缺失数据。")]),
    );
  } catch (error) {
    $("#db-kpis").replaceChildren(card("读取失败", error.message));
  }
}
async function renderApis() {
  try {
    const data = await get("/api/apis");
    const nodes = data.scripts.map((s) => card(s.name, s.cmd, "npm run"));
    for (const name of [
      "stats",
      "health",
      "crawl-log",
      "features",
      "apis",
      "snapshots",
    ])
      nodes.push(
        card(`GET /api/${name}`, `${location.origin}/api/${name}`, "Hub"),
      );
    $("#apis-grid").replaceChildren(...nodes);
  } catch (error) {
    $("#apis-grid").replaceChildren(card("读取失败", error.message));
  }
}
async function renderFeatures() {
  try {
    const features = await get("/api/features");
    $("#features-grid").replaceChildren(
      ...(features.length
        ? features.map((f) => card(f.title, f.id, f.status))
        : [card("暂无本地项目记录", "此区域读取项目 features 目录。")]),
    );
  } catch (error) {
    $("#features-grid").replaceChildren(card("读取失败", error.message));
  }
}
async function renderHealth() {
  try {
    const health = await get("/api/health");
    $("#meta-health").textContent = health.healthy
      ? `种子数据可用 · ${health.seed_entries} 款`
      : `数据异常：${health.error ?? "无数据"}`;
    $("#meta-health").className = `badge ${health.healthy ? "" : "err"}`;
  } catch {
    $("#meta-health").textContent = "健康检查失败";
  }
}
async function refresh() {
  await Promise.allSettled([
    renderHealth(),
    renderLog(),
    renderStats(),
    renderApis(),
    renderFeatures(),
  ]);
  $("#meta-time").textContent = `更新于 ${new Date().toLocaleString()}`;
  setTimeout(refresh, 30000);
}
document.addEventListener("DOMContentLoaded", refresh);
