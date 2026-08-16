import { readFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import Link from "next/link";
import ToggleSkill from "./_components/ToggleSkill";

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

type IntentEntry = {
  id: string;
  label: string;
  description?: string;
  enabled?: boolean;
  [key: string]: unknown;
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

async function loadFirstLines(filePath: string, max: number): Promise<{ text: string; total: number } | null> {
  try {
    const txt = await readFile(filePath, "utf8");
    const lines = txt.split("\n");
    return { text: lines.slice(0, max).join("\n"), total: lines.length };
  } catch {
    return null;
  }
}

async function loadJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    const txt = await readFile(filePath, "utf8");
    return JSON.parse(txt) as T;
  } catch {
    return null;
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

// Map `handlerFile` (e.g. "lib/skills/recommend/execute.ts") to a category
// directory ("recommend") — the convention is the second path segment.
// We use this to look up `lib/skills/<category>/profile.json` if it exists.
function categoryFromHandler(handlerFile: string): string {
  const parts = handlerFile.split("/");
  // expected: ["lib", "skills", "<category>", "execute.ts"]
  return parts[2] ?? "";
}

async function loadSkillDetail(s: { id: string; handlerFile: string }) {
  const cat = categoryFromHandler(s.handlerFile);
  const execPath = join(process.cwd(), s.handlerFile);
  const exec = await loadFirstLines(execPath, 80);
  const profilePath = cat ? join(process.cwd(), "lib", "skills", cat, "profile.json") : "";
  const profile = profilePath ? await loadJsonSafe<unknown>(profilePath) : null;
  return {
    exec,
    profile,
    profilePretty: profile !== null ? JSON.stringify(profile, null, 2) : null,
  };
}

async function loadIntentsBySkill(): Promise<Map<string, IntentEntry[]>> {
  const map = new Map<string, IntentEntry[]>();
  try {
    const raw = await readFile("data/intent-registry.json", "utf8");
    const arr = JSON.parse(raw) as IntentEntry[];
    for (const intent of arr) {
      // Intent <-> skill id is 1:1 by id (manifest is keyed by skill id,
      // intent-registry is keyed by intent id — same 8 values).
      if (!map.has(intent.id)) map.set(intent.id, []);
      map.get(intent.id)!.push(intent);
    }
  } catch {
    // ignore — detail UI will just show "no intent mapping"
  }
  return map;
}

// ── Page (server component) ──────────────────────────────────────────────

export const dynamic = "force-dynamic"; // always re-read manifest on request

export default async function HarnessPage() {
  const [
    { manifest, builtin, handlerCounts },
    crawler,
    head,
    intentsBySkill,
  ] = await Promise.all([
    loadSkills(),
    loadCrawler(),
    getHead(),
    loadIntentsBySkill(),
  ]);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  // Pre-load all skill details (execute.ts first 80 lines + profile.json).
  const detailBySkill = new Map<string, Awaited<ReturnType<typeof loadSkillDetail>>>();
  await Promise.all(
    builtin.map(async (s) => {
      detailBySkill.set(s.id, await loadSkillDetail(s));
    }),
  );

  return (
    <main className="harness-main">
      <style>{`
        .harness-main { background: #0f1115; color: #e8eaf0; min-height: 100vh;
          font: 14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", sans-serif; }
        .harness-main * { box-sizing: border-box; }
        .top-nav { padding: 14px 40px; background: #1f232c; border-bottom: 1px solid #2a2f3a;
          display: flex; gap: 18px; align-items: center; }
        .top-nav a { color: #4cb3ff; text-decoration: none; font-size: 13px; font-weight: 500;
          padding: 4px 10px; border-radius: 6px; }
        .top-nav a:hover { background: #2a2f3a; }
        .top-nav a.active { background: #2a2f3a; color: #f5a524; }
        .top-nav .nav-spacer { flex: 1; }
        .top-nav .nav-head { font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 11px; color: #9aa3b2; }
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
        .skill-toggle { font-size: 11px; padding: 3px 10px; border-radius: 6px; border: 1px solid transparent;
          cursor: pointer; font-weight: 600; letter-spacing: 0.3px; transition: background 0.12s, border 0.12s; }
        .skill-toggle.on { background: #4b5563; color: #f3f4f6; border-color: #6b7280; }
        .skill-toggle.on:hover { background: #374151; }
        .skill-toggle.off { background: #166534; color: #d1fae5; border-color: #15803d; }
        .skill-toggle.off:hover { background: #14532d; }
        .skill-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
        .skill-details { margin-top: 8px; }
        .skill-details > summary { cursor: pointer; color: #9aa3b2; font-size: 11px;
          padding: 4px 0; user-select: none; }
        .skill-details > summary:hover { color: #4cb3ff; }
        .skill-details > summary::marker { color: #4cb3ff; }
        .skill-detail-body { padding: 10px 0 4px; display: flex; flex-direction: column; gap: 10px; }
        .skill-detail-section { background: #0f1115; border: 1px solid #2a2f3a; border-radius: 6px; padding: 10px 12px; }
        .skill-detail-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
        .skill-detail-title { font-size: 10px; color: #f5a524; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
        .skill-detail-meta { font-size: 10px; color: #9aa3b2; }
        .code { margin: 0; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px;
          line-height: 1.5; color: #e8eaf0; overflow: auto; max-height: 320px; white-space: pre; }
        .intent-map { display: flex; flex-wrap: wrap; gap: 4px; }
        .intent-chip { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 10px;
          background: #1e3a8a; color: #bfdbfe; padding: 2px 6px; border-radius: 4px; }
        .intent-empty { color: #9aa3b2; font-size: 11px; font-style: italic; }
        .module-row { padding: 14px 24px; border-bottom: 1px solid #2a2f3a; display: flex; align-items: baseline; gap: 14px; }
        .module-row:last-child { border-bottom: none; }
        .module-name { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #4cb3ff; font-size: 13px; min-width: 220px; }
        .module-loc { color: #4ade80; font-size: 11px; min-width: 80px; }
        .module-desc { color: #9aa3b2; font-size: 12px; }
        .block-legend { padding: 14px 24px; color: #9aa3b2; font-size: 12px; background: #1f232c; border-top: 1px solid #2a2f3a; }
        .block-legend code { color: #f5a524; }
      `}</style>

      <nav className="top-nav">
        <span className="nav-head">🍺 Beer Lens</span>
        <Link href="/harness" className="active">/harness</Link>
        <Link href="/beers">/beers</Link>
        <span className="nav-spacer" />
        <span className="nav-head">skills harness · crawler</span>
      </nav>

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
              const detail = detailBySkill.get(s.id);
              const intents = intentsBySkill.get(s.id) ?? [];
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
                    <ToggleSkill id={s.id} initialEnabled={s.enabled} />
                  </div>
                  <div className="skill-path">{s.handlerFile}</div>
                  <details className="skill-details">
                    <summary>细节</summary>
                    <div className="skill-detail-body">
                      <div className="skill-detail-section">
                        <div className="skill-detail-head">
                          <span className="skill-detail-title">execute.ts (前 80 行)</span>
                          {detail?.exec ? (
                            <span className="skill-detail-meta">
                              {detail.exec.text.split("\n").length} / {detail.exec.total} 行
                            </span>
                          ) : (
                            <span className="skill-detail-meta">未找到</span>
                          )}
                        </div>
                        {detail?.exec ? (
                          <pre className="code">{detail.exec.text}</pre>
                        ) : (
                          <div className="intent-empty">execute.ts 不可读</div>
                        )}
                      </div>
                      <div className="skill-detail-section">
                        <div className="skill-detail-head">
                          <span className="skill-detail-title">profile.json</span>
                          <span className="skill-detail-meta">
                            {detail?.profilePretty ? "已挂载" : "未挂载"}
                          </span>
                        </div>
                        {detail?.profilePretty ? (
                          <pre className="code">{detail.profilePretty}</pre>
                        ) : (
                          <div className="intent-empty">该 skill 未提供 profile.json</div>
                        )}
                      </div>
                      <div className="skill-detail-section">
                        <div className="skill-detail-head">
                          <span className="skill-detail-title">关联 intent</span>
                          <span className="skill-detail-meta">
                            {intents.length > 0 ? `${intents.length} 个` : "无"}
                          </span>
                        </div>
                        {intents.length > 0 ? (
                          <div className="intent-map">
                            {intents.map((it) => (
                              <span key={it.id} className="intent-chip">
                                {it.id}
                                {it.label ? ` · ${it.label}` : ""}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <div className="intent-empty">intent-registry 中未匹配到该 skill</div>
                        )}
                      </div>
                    </div>
                  </details>
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
