// Direct, LLM-free MBCB red/Rat (鼠场) catalog lookup for Feishu.
//
// Explicit text commands only:
//   /mbcb                 list first page (#id, name, brewery)
//   /mbcb <query>         unique -> detail; several -> candidates; none -> hint
//   /mbcb 第2页           paging; 第N页 can be appended to any query
//   MBCB 第二场 <query>   same catalog, red session
//   MBCB 鼠场 <query>     same catalog, red session
//
// Anything that does not match an explicit command returns null so the
// normal agent chat path is preserved unchanged.

import { execFile } from "node:child_process";
import path from "node:path";

const DEFAULT_DB = path.join(".beer-data", "beer.db");
const DEFAULT_PAGE_SIZE = 20;

export interface MbcbHandleOptions {
  /** Override SQLite path (tests use a temp db). */
  dbPath?: string;
  /** Project root; defaults to process.cwd(). Script lives in <cwd>/scripts. */
  cwd?: string;
  /** Python executable name/path, defaults to python3. */
  python?: string;
}

interface CatalogEnvelope {
  event_id: string;
  session: string;
  available?: boolean;
  reason?: string;
  total: number;
  page: number;
  page_size: number;
  results: BeerRecord[];
}

interface BeerRecord {
  event_beer_id: number;
  name: string;
  name_zh?: string | null;
  brewery: string;
  brewery_zh?: string | null;
  sessions?: string[];
  style?: string | null;
  abv?: number | null;
  description?: string | null;
  description_zh?: string | null;
  description_zh_review_status?: string | null;
  untappd_id?: number | null;
  rating_raw?: number | null;
  rating_count?: number | null;
  rating_usable?: boolean;
  source_url?: string | null;
  retrieved_at?: string | null;
  issues?: string[];
  missing_fields?: string[];
  aliases?: string[];
  [k: string]: unknown;
}

interface ParsedCommand {
  query: string;
  page: number;
}

const SLASH_RE = /^[／/]mbcb(?:\s+([\s\S]*))?$/i;
const SESSION_RE = /^MBCB\s+(?:第二场|第2场|鼠场)(?:\s+([\s\S]*))?$/i;
const PAGE_RE = /第\s*(\d{1,3})\s*页/g;

/** Returns the parsed command, or null when the text is not a catalog command. */
export function parseMbcbCommand(text: string): ParsedCommand | null {
  const trimmed = (text ?? "").trim();
  const match = trimmed.match(SLASH_RE) ?? trimmed.match(SESSION_RE);
  if (!match) return null;
  const args = match[1] ?? "";
  let page = 1;
  const query = args
    .replace(PAGE_RE, (_all, digits: string) => {
      page = Number(digits);
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { query, page };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCatalogCli(
  args: string[],
  cwd: string,
  python: string,
): Promise<CliResult> {
  const script = path.join(cwd, "scripts", "mbcb-catalog.py");
  return new Promise((resolve, reject) => {
    execFile(
      python,
      [script, ...args],
      { cwd, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        if (e && e.code === "ENOENT") {
          reject(err);
          return;
        }
        const code = e && typeof e.code === "number" ? e.code : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function sessionLabel(session: string): string {
  return session === "red" ? "red（红/鼠场）" : session;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function candidateLine(rec: BeerRecord): string {
  const zh = asString(rec.name_zh);
  return `#${rec.event_beer_id} ${rec.name} — ${rec.brewery}${zh ? `（菜单名：${zh}）` : ""}`;
}

/** Reduce an ISO timestamp to a concise calendar date; never dump raw ISO metadata. */
function snapshotDate(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s.slice(0, 20);
}

function formatAbvLine(rec: BeerRecord): string {
  const abv = asFiniteNumber(rec.abv);
  const hasAbvConflict = asStringList(rec.issues).includes("abv_database_disagreement");
  if (abv === null) {
    // Keep the conflict visible in human terms even without a menu numeric;
    // the raw issue token itself is never shown.
    return hasAbvConflict
      ? "ABV：未知（来源未提供，不代表 0%；该字段另有未解决的来源冲突）"
      : "ABV：未知（来源未提供，不代表 0%）";
  }
  const suffix = hasAbvConflict
    ? "（菜单值；与外部旧缓存数据存在未解决冲突，请勿据此做严格酒精度推荐）"
    : "";
  return `ABV：${formatNumber(abv)}%${suffix}`;
}

/**
 * Source descriptions: reviewed Chinese paraphrases plus the English original
 * are both welcome; an unreviewed/missing translation leaves the publisher's
 * English text (clearly labelled) instead of presenting a guess as Chinese.
 */
function descriptionLines(rec: BeerRecord): string[] {
  const zhDesc = asString(rec.description_zh);
  const enDesc = asString(rec.description);
  if (rec.description_zh_review_status === "parent_spotchecked" && zhDesc) {
    const lines = [`简介：${oneLine(zhDesc)}`];
    if (enDesc) lines.push(`原文简介：${oneLine(enDesc)}`);
    return lines;
  }
  if (enDesc) {
    return [`简介（来源原文·英文）：${oneLine(enDesc)}`];
  }
  // No source description at all: do not infer flavor from a product name
  // (e.g. "Ice Tea" is not evidence of tea flavor or zero alcohol).
  return ["简介：来源未提供，无法据此判断口味（酒名本身不代表风味或酒精度）"];
}

function formatDetail(rec: BeerRecord): string {
  const lines: string[] = [`#${rec.event_beer_id} ${rec.name} — ${rec.brewery}`];

  const nameZh = asString(rec.name_zh);
  if (nameZh) lines.push(`菜单中文名：${nameZh}`);
  const aliases = asStringList(rec.aliases);
  if (aliases.length) lines.push(`别名：${aliases.join("、")}`);

  lines.push(formatAbvLine(rec));

  // Show a UT score only when it is a real, attributable rating with a count.
  const rating = asFiniteNumber(rec.rating_raw);
  const count = asFiniteNumber(rec.rating_count);
  const hasUsableRating =
    rec.rating_usable === true && rating !== null && rating > 0 && count !== null && count > 0;

  // Sparse record (no style AND no description): collapse the unknown
  // style/description/rating fields into one readable sentence instead of
  // three "未知" rows. ABV (known/unknown/conflict) above is always preserved.
  const sparse = !asString(rec.description) && asString(rec.style) === null;
  if (sparse) {
    lines.push(
      "风格、简介与 Untappd 评分：来源未提供；无法据此判断口味与风格（酒名本身不代表风味或酒精度），暂无可用评分，不作为质量依据。",
    );
  } else {
    lines.push(`风格：${asString(rec.style) ?? "未知（来源未提供）"}`);
    if (hasUsableRating) {
      lines.push(`Untappd 评分：${rating!.toFixed(2)}（${formatNumber(count!)} 人评分）`);
    } else {
      lines.push("Untappd 评分：暂无可用评分");
    }
    lines.push(...descriptionLines(rec));
  }

  const sessions = asStringList(rec.sessions);
  if (sessions.length) lines.push(`场次：${sessions.map(sessionLabel).join(" / ")}`);

  // Source attribution stays, but as one concise line (URL + calendar date).
  const sourceUrl = asString(rec.source_url);
  const date = snapshotDate(rec.retrieved_at);
  if (sourceUrl || date) {
    lines.push(`来源：${sourceUrl ?? "未注明"}${date ? ` · 数据快照 ${date}` : ""}`);
  }

  // Raw issues[] / missing_fields[] arrays are internal QA metadata, never
  // dumped row by row; the sparse record gets one actionable follow-up offer.
  if (sparse) {
    lines.push("价格、容量与实时库存目录暂缺；想判断性价比的话，把菜单上的价格发我即可。");
  } else {
    lines.push("提示：价格、容量、摊位与实时库存目录未提供，未作推断。");
  }
  return lines.join("\n");
}

function formatEnvelope(envelope: CatalogEnvelope, query: string): string {
  const { total, page, page_size: pageSize, results } = envelope;
  const baseHeader =
    `MBCB 红/鼠场目录（共 ${total} 款 · 第 ${page} 页，每页 ${pageSize || DEFAULT_PAGE_SIZE}）`;

  if (total > 0 && results.length === 0) {
    return `${baseHeader}\n页码超出范围，请查看第 1 至 ${Math.ceil(total / (pageSize || DEFAULT_PAGE_SIZE))} 页。`;
  }

  if (query.trim() === "") {
    if (total === 0) return `${baseHeader}\n目录当前没有酒款。`;
    const lines = results.map(candidateLine);
    lines.push("发 /mbcb #编号 查看详情，/mbcb 第2页 翻页。");
    return `${baseHeader}\n${lines.join("\n")}`;
  }

  if (total === 0) {
    return `没有找到与「${query}」匹配的酒款。可换用酒厂名 / 中文菜单名，或用 /mbcb #编号 精确查询。`;
  }
  if (total === 1 && results.length === 1) {
    return formatDetail(results[0]);
  }
  return [
    `找到 ${total} 个候选（第 ${page} 页），未自动选择；请用 #编号 或“酒厂 + 酒名”确认：`,
    ...results.map(candidateLine),
    "发 /mbcb #编号 查看详情。",
  ].join("\n");
}

function unavailableMessage(envelope: CatalogEnvelope | null): string {
  if (envelope?.reason === "catalog_missing") {
    return "MBCB 红场目录尚未导入，请稍后再试或联系管理员导入。";
  }
  if (envelope?.reason === "db_missing") {
    return "MBCB 目录数据库暂未就绪，请稍后再试。";
  }
  return "MBCB 目录暂时不可用，请稍后再试。";
}

/**
 * Handle an explicit MBCB catalog command.
 *
 * @returns formatted reply string for a command, or null for non-commands
 *   (so the caller continues ordinary chat handling).
 */
export async function handleMbcbQuery(
  text: string,
  options: MbcbHandleOptions = {},
): Promise<string | null> {
  const parsed = parseMbcbCommand(text);
  if (!parsed) return null;

  const cwd = options.cwd ?? process.cwd();
  const dbPath = options.dbPath ?? path.join(cwd, DEFAULT_DB);

  let envelope: CatalogEnvelope | null = null;
  try {
    const result = await runCatalogCli(
      ["--db", dbPath, "--query", parsed.query, "--page", String(parsed.page)],
      cwd,
      options.python ?? "python3",
    );
    if (result.code !== 0 || !result.stdout.trim()) {
      return unavailableMessage(null);
    }
    envelope = JSON.parse(result.stdout) as CatalogEnvelope;
  } catch {
    return unavailableMessage(null);
  }

  if (!envelope || envelope.available === false) {
    return unavailableMessage(envelope);
  }
  try {
    return formatEnvelope(envelope, parsed.query);
  } catch {
    return unavailableMessage(null);
  }
}
