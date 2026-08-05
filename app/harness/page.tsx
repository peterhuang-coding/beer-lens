import { readFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// ── Data loading (server-side, runs at request time) ─────────────────────

type SkillManifest = {
  version: number;
  name: string;
  description: string;
  defaultEnabled: string[];
  skills: Array<{
    id: string;
    label: string;
    description: string;
    handlerFile: string;
    preferred: string;
    enabled: boolean;
  }>;
  updatedAt?: string;
};

async function lineCount(p: string): Promise<number> {
  const txt = await readFile(p, "utf8");
  return txt.split("\n").length;
}

async function listFiles(dir: string, suffix?: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && (!suffix || e.name.endsWith(suffix)))
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

async function loadSkills() {
  const manifest = JSON.parse(
    await readFile("data/skills/manifest.json", "utf8"),
  ) as SkillManifest;
  const builtin = manifest.skills.filter((s) =>
    manifest.defaultEnabled.includes(s.id),
  );
  const handlerCounts = new Map<string, number>();
  for (const s of builtin) {
    handlerCounts.set(s.handlerFile, (handlerCounts.get(s.handlerFile) ?? 0) + 1);
  }
  return { manifest, builtin, handlerCounts };
}

async function loadCrawler() {
  const root = process.cwd();
  const tsFiles = await listFiles(join(root, "lib/crawler"), ".ts");
  const mdFiles = await listFiles(join(root, "lib/crawler"), ".md");
  const fixtures = await listFiles(join(root, "data/crawler/_fixtures"), ".html");
  const modules: Array<{ name: string; loc: number | string; full: string }> = [];
  for (const f of [...mdFiles, ...tsFiles]) {
    const name = f.split("/").pop()!;
    const isMd = name.endsWith(".md");
    const loc = isMd ? "spec" : await lineCount(f);
    modules.push({ name, loc, full: f.replace(`${root}/`, "") });
  }
  return { modules, fixtures };
}

async function getHead(): Promise<string> {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

// ── Page (server component) ──────────────────────────────────────────────

export const dynamic = "force-dynamic"; // always re-read manifest on request

export default async function HarnessPage() {
  const [{ manifest, builtin, handlerCounts }, crawler, head] = await Promise.all(
    [loadSkills(), loadCrawler(), getHead()],
  );
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  return (
    <main className="harness-main">
      <style>{`
        .harness-main { background: #0f1115; color: #e8eaf0; min-height: 100vh;
          font: 14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", sans-serif; }
        .harness-main * { box-sizing: border-box; }
        .harness-header { padding: 28px 40px 18px; border-bottom: 1px solid #2a2f3a; }
        .harness-header h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; }
        .harness-meta { color: #9aa3b2; font-size: 12px; }
        .harness-meta code { background: #171a21; padding: 1px 6px; border-radius: 4px; color: #f5a524; }
        .harness-content { padding: 28px 40px 60px; display: grid; gap: 32px; max-width: 1200px; margin: 0 auto; }
        .harness-block { background: #171a21; border: 1px solid #2a2f3a; border-radius: 10px; overflow: hidden; }
        .harness-block-head { padding: 18px 24px; background: #1f232c; border-bottom: 1px solid #2a2f3a;
          display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
        .harness-block-head h2 { margin: 0; font-size: 16px; font-weight: 600; color: #f5a524; }
        .harness-block-head .sub { color: #9aa3b2; font-size: 12px; }
        .harness-block-head .counts { margin-left: auto; color: #9aa3b2; font-size: 12px; }
        .harness-block-head .counts b { color: #e8eaf0; font-weight: 600; }
        .skills-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1px; background: #2a2f3a; }
        .skill-card { background: #171a21; padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; }
        .skill-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
        .skill-id { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; color: #4cb3ff; }
        .skill-label { font-weight: 600; font-size: 14px; }
        .skill-desc { color: #9aa3b2; font-size: 12px; min-height: 2.6em; }
        .skill-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
        .pill { font-size: 10px; padding: 2px 8px; border-radius: 999px; font-weight: 600;
          letter-spacing: 0.4px; text-transform: uppercase; }
        .pill.on { background: #166534; color: #d1fae5; }
        .pill.off { background: #4b5563; color: #d1d5db; }
        .pill.shared { background: #1e3a8a; color: #bfdbfe; }
        .skill-path { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; color: #9aa3b2; word-break: break-all; }
        .module-row { padding: 14px 24px; border-bottom: 1px solid #2a2f3a; display: flex; align-items: baseline; gap: 14px; }
        .module-row:last-child { border-bottom: none; }
        .module-name { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #4cb3ff; font-size: 13px; min-width: 220px; }
        .module-loc { color: #4ade80; font-size: 11px; min-width: 80px; }
        .module-desc { color: #9aa3b2; font-size: 12px; }
        .block-legend { padding: 14px 24px; color: #9aa3b2; font-size: 12px; background: #1f232c; border-top: 1px solid #2a2f3a; }
        .block-legend code { color: #f5a524; }
      `}</style>

      <header className="harness-header">
        <h1>🍺 Beer-Lens Harness Platform</h1>
        <div className="harness-meta">
          Repo <code>/Volumes/SanDisk2TB/beer-lens</code> · HEAD <code>{head}</code> · Generated <code>{now}</code> ·
          {" "}<b>2</b> harnesses · <b>{builtin.length}</b> builtin skills · <b>{crawler.modules.length}</b> crawler modules
        </div>
      </header>

      <div className="harness-content">

        <section className="harness-block">
          <div className="harness-block-head">
            <h2>1. Skills Harness</h2>
            <span className="sub">lib/harness/{`{types,router,skill-registry}.ts`}</span>
            <span className="counts"><b>{builtin.length}</b> builtin skills · <b>{handlerCounts.size}</b> executors</span>
          </div>
          <div className="skills-grid">
            {builtin.map((s) => {
              const shared = (handlerCounts.get(s.handlerFile) ?? 0) > 1;
              return (
                <div key={s.id} className="skill-card">
                  <div className="skill-card-head">
                    <span className="skill-id">{s.id}</span>
                    <span className="skill-label">{s.label}</span>
                  </div>
                  <div className="skill-desc">{s.description}</div>
                  <div className="skill-foot">
                    <span className={`pill ${s.enabled ? "on" : "off"}`}>{s.enabled ? "ON" : "OFF"}</span>
                    {shared ? <span className="pill shared">shared</span> : null}
                  </div>
                  <div className="skill-path">{s.handlerFile}</div>
                </div>
              );
            })}
          </div>
          <div className="block-legend">
            <code>preferredHandler: "active"</code> 走 active pipeline 平行；
            legacy <code>lib/beer-agent/orchestrator.ts</code> 保留为参考，待 v0.2 加 <code>@deprecated</code>。
          </div>
        </section>

        <section className="harness-block">
          <div className="harness-block-head">
            <h2>2. Crawler Harness</h2>
            <span className="sub">lib/crawler/*.ts · bin/beer-lens-crawl.mjs · data/crawler/_fixtures/</span>
            <span className="counts"><b>{crawler.modules.length}</b> modules · <b>{crawler.fixtures.length}</b> fixtures · <b>1</b> CLI entry</span>
          </div>
          {crawler.modules.map((m) => (
            <div className="module-row" key={m.name}>
              <span className="module-name">{m.name}</span>
              <span className="module-loc">{typeof m.loc === "number" ? `${m.loc} LoC` : m.loc}</span>
              <span className="module-desc">{m.full}</span>
            </div>
          ))}
          <div className="block-legend">
            CLI: <code>node bin/beer-lens-crawl.mjs --help</code> ·
            测试: <code>node --test tests/crawler-*.test.mts</code> ·
            数据: <code>node bin/beer-lens-crawl.mjs --source untappd --limit 100 --dry-run</code>
          </div>
        </section>

      </div>
    </main>
  );
}