/**
 * Event catalog grounding — attach the CURRENT integrated event catalog
 * (mbcb-2026 red session) to OCR menu candidates, without any model/network call.
 *
 * Strict identity only:
 *   - normalized-exact name equal to record.name / name_zh / aliases[i]
 *   - when the OCR row supplies a brewery it must equal brewery / brewery_zh
 *   - a same-name beer from a different brewery, or an unresolved same-name
 *     ambiguity (e.g. "Helles" with no brewery), stays unmatched
 *   - menuIndex is the poster row number; it is NEVER treated as event_beer_id
 *
 * On a unique match the current catalog supersedes stale legacy facts
 * (known ABV / style / a usable Untappd rating). OCR-facing fields
 * (displayName, brewery, price, volumeMl, currency, servingMode, menuIndex)
 * are preserved verbatim. Catalog-absent facts stay unknown — they are never
 * back-filled from stale DB rows or model imagination.
 *
 * The event listing is evidence of what the venue pours, NOT an authoritative
 * brewery verification; existing brewery-verification warnings are retained.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BeerCandidate, Evidence } from "./types";

// ── Catalog record shape (data/events/mbcb-2026-red.json) ──

export type EventCatalogBeer = {
  event_id: string;
  event_beer_id: number;
  name: string;
  name_zh: string | null;
  brewery: string;
  brewery_zh: string | null;
  sessions: string[];
  style: string | null;
  abv: number | null;
  description: string | null;
  untappd_id: number | null;
  rating_raw: number | null;
  rating_count: number | null;
  rating_usable: boolean;
  source_url: string;
  retrieved_at: string;
  issues: string[];
  field_disagreements: Record<string, unknown>;
  aliases: string[];
};

/** Structural guard; one bad row must not poison the rest of the catalog. */
function isEventCatalogBeer(value: unknown): value is EventCatalogBeer {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  for (const key of ["aliases", "issues", "sessions"]) {
    if (r[key] != null && (!Array.isArray(r[key]) || !(r[key] as unknown[]).every(v => typeof v === "string"))) return false;
  }
  return (
    typeof r.event_id === "string" &&
    typeof r.event_beer_id === "number" &&
    Number.isFinite(r.event_beer_id) &&
    typeof r.name === "string" &&
    r.name.trim().length > 0 &&
    typeof r.brewery === "string" &&
    r.brewery.trim().length > 0
  );
}

/** Relative to process.cwd(); resolved per call so tests can chdir. */
export const EVENT_CATALOG_RELATIVE_PATH = path.join("data", "events", "mbcb-2026-red.json");

/**
 * Fail-soft catalog reader. Missing file, malformed JSON, non-array payload or
 * unreadable rows degrade to the existing pipeline (empty list), never throw.
 */
export async function readEventCatalog(): Promise<EventCatalogBeer[]> {
  try {
    const raw = await readFile(path.join(process.cwd(), EVENT_CATALOG_RELATIVE_PATH), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEventCatalogBeer);
  } catch {
    return [];
  }
}

// ── Strict matching ──

/** Normalized-exact key: NFKC, lowercase, keep letters/numbers only (CJK safe). */
function strictKey(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function nameKeys(record: EventCatalogBeer): Set<string> {
  const keys = new Set<string>();
  for (const value of [record.name, record.name_zh, ...(record.aliases ?? [])]) {
    if (typeof value === "string" && value.trim()) {
      const key = strictKey(value);
      if (key) keys.add(key);
    }
  }
  return keys;
}

function breweryKeys(record: EventCatalogBeer): Set<string> {
  const keys = new Set<string>();
  for (const value of [record.brewery, record.brewery_zh]) {
    if (typeof value === "string" && value.trim()) {
      const key = strictKey(value);
      if (key) keys.add(key);
    }
  }
  return keys;
}

type UniqueMatch = { status: "unique"; record: EventCatalogBeer };
type MatchResult = UniqueMatch | { status: "ambiguous" } | { status: "none" };

function dedupeById(records: EventCatalogBeer[]): EventCatalogBeer[] {
  const seen = new Set<number>();
  const out: EventCatalogBeer[] = [];
  for (const record of records) {
    if (seen.has(record.event_beer_id)) continue;
    seen.add(record.event_beer_id);
    out.push(record);
  }
  return out;
}

/**
 * Resolve one OCR candidate against the catalog.
 * Identity is name (+ brewery when supplied) only. menuIndex / candidateId
 * numbers never participate.
 */
function resolveMatch(candidate: BeerCandidate, records: EventCatalogBeer[]): MatchResult {
  const name = strictKey(candidate.displayName);
  if (!name) return { status: "none" };

  let hits = records.filter(record => nameKeys(record).has(name));
  if (hits.length === 0) return { status: "none" };
  hits = dedupeById(hits);

  const brewery = strictKey(candidate.brewery);
  if (brewery) {
    const scoped = hits.filter(record => breweryKeys(record).has(brewery));
    if (scoped.length === 0) return { status: "none" }; // same name, other brewery
    if (scoped.length > 1) return { status: "ambiguous" };
    return { status: "unique", record: scoped[0] };
  }

  if (hits.length === 1) return { status: "unique", record: hits[0] };
  return { status: "ambiguous" }; // e.g. "Helles" #96 vs #599 without brewery
}

// ── OCR-explicit ABV provenance channel ──
//
// After assembly a candidate.abv may originate from OCR or from a legacy
// enrichment; provider.ts marks the OCR-claimed value with this evidence so a
// catalog disagreement can be recorded as an OCR-vs-event conflict rather than
// a silent stale-data supersede.

export const OCR_EXPLICIT_ABV_PREFIX = "菜单明示酒精度";

export function ocrExplicitAbvEvidence(abv: number, confidence = 0.6): Evidence {
  return {
    source: "ocr",
    confidence,
    summary: `${OCR_EXPLICIT_ABV_PREFIX} ${abv}%（OCR 提取，以整合活动目录核对为准）`,
  };
}

function readOcrExplicitAbv(candidate: BeerCandidate): number | null {
  const pattern = new RegExp(`${OCR_EXPLICIT_ABV_PREFIX}\\s*([0-9]+(?:\\.[0-9]+)?)\\s*%`);
  for (const entry of candidate.evidence ?? []) {
    if (entry?.source !== "ocr" || typeof entry.summary !== "string") continue;
    const match = pattern.exec(entry.summary);
    if (match) return Number(match[1]);
  }
  return null;
}

// ── Risk flags / evidence wording ──

export const RISK_EVENT_ABV_UNKNOWN = "整合活动目录未标注 ABV（未知，非无醇 0%）";
export const RISK_EVENT_RATING_UNUSABLE = "整合活动目录无有效 Untappd 评分，不作评分依据";
export const RISK_EVENT_ABV_CONFLICT = "OCR 明示 ABV 与整合活动目录不一致";

export type GroundingOutcome = {
  matched: true;
  eventId: string;
  eventBeerId: number;
  evidence: Evidence;
};

/** Structured access to grounding provenance without new candidate fields. */
export function getGrounding(candidate: BeerCandidate): GroundingOutcome | null {
  for (let i = candidate.evidence.length - 1; i >= 0; i--) {
    const entry = candidate.evidence[i];
    if (entry.source !== "venue_site") continue;
    const match = /\[event_beer_id:(\d+)]/.exec(entry.summary ?? "");
    const eventMatch = /\[event_id:([^\]]+)]/.exec(entry.summary ?? "");
    if (match) {
      return {
        matched: true,
        eventBeerId: Number(match[1]),
        eventId: eventMatch?.[1] ?? "",
        evidence: entry,
      };
    }
  }
  return null;
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function buildGroundingEvidence(
  record: EventCatalogBeer,
  context: { abvConflict: { ocr: number; catalog: number } | null; ocrAbvWithMissingCatalog: number | null; usable: boolean },
): Evidence {
  const retrievedDate = String(record.retrieved_at ?? "").slice(0, 10) || "未知日期";
  const breweryZh = record.brewery_zh ? `（${record.brewery_zh}）` : "";
  const clauses: string[] = [];

  clauses.push(
    `整合活动目录列示 ${record.event_id} [event_id:${record.event_id}] [event_beer_id:${record.event_beer_id}] #${record.event_beer_id}：${record.brewery}${breweryZh} / ${record.name}`,
  );
  // The listing is a menu, not an authoritative verification of the brewery.
  clauses.push(`来源 venue_site：${record.source_url}，抓取于 ${retrievedDate}`);

  // Original description only — never an unverified Chinese paraphrase.
  if (typeof record.description === "string" && record.description.trim()) {
    clauses.push(`目录描述（原文，未翻译）：${record.description.trim()}`);
  } else {
    clauses.push("整合活动目录无描述（未知，不以其他来源补全）");
  }

  if (finitePositive(record.abv)) {
    clauses.push(`ABV ${record.abv}%（整合活动目录数据）`);
  } else {
    clauses.push("ABV 整合活动目录未标注（未知；数值 0 仅为类型占位，不代表无醇）");
  }
  if (context.abvConflict) {
    clauses.push(
      `ABV 分歧：OCR 菜单明示 ${context.abvConflict.ocr}%，酒单列 ${context.abvConflict.catalog}%，两种口径并存，勿确信单值`,
    );
  } else if (context.ocrAbvWithMissingCatalog != null) {
    clauses.push(
      `OCR 菜单明示 ${context.ocrAbvWithMissingCatalog}%，但整合活动目录未标注 ABV，未经酒单确认`,
    );
  }

  if (context.usable && finitePositive(record.rating_raw) && finitePositive(record.rating_count)) {
    clauses.push(
      `Untappd 评分 ${record.rating_raw}（${record.rating_count} 人评分${record.untappd_id != null ? `，UT 酒款 ID ${record.untappd_id}` : ""}；评分随酒单数据抓取）`,
    );
  } else {
    clauses.push(
      `Untappd 无有效评分（rating_usable=${record.rating_usable === true}，rating_raw=${record.rating_raw ?? "null"}，count=${record.rating_count ?? 0}），不作评分依据`,
    );
  }

  for (const issue of record.issues ?? []) {
    if (typeof issue === "string" && issue) clauses.push(`酒单数据标记：${issue}`);
  }

  const confidence = context.abvConflict
    ? 0.55
    : (record.issues ?? []).length > 0 || !finitePositive(record.abv)
      ? 0.8
      : 0.9;

  return { source: "venue_site", confidence, summary: clauses.join("；") };
}

function applyGrounding(candidate: BeerCandidate, record: EventCatalogBeer): BeerCandidate {
  const out: BeerCandidate = {
    ...candidate,
    evidence: [...candidate.evidence],
    riskFlags: [...candidate.riskFlags],
  };

  const addFlag = (flag: string) => {
    if (!out.riskFlags.includes(flag)) out.riskFlags.push(flag);
  };

  // ── ABV: current catalog wins on strict unique identity ──
  const ocrAbv = readOcrExplicitAbv(candidate);
  let abvConflict: { ocr: number; catalog: number } | null = null;
  let ocrAbvWithMissingCatalog: number | null = null;
  if (finitePositive(record.abv)) {
    if (ocrAbv != null && Math.abs(ocrAbv - record.abv) > 0.05) {
      abvConflict = { ocr: ocrAbv, catalog: record.abv };
      addFlag(RISK_EVENT_ABV_CONFLICT);
    }
    out.abv = record.abv; // supersedes stale legacy / OCR-conflicting value
  } else {
    // Missing remains numeric 0 for legacy type compatibility, with an explicit
    // unknown flag/evidence — it must never read as alcohol-free.
    out.abv = 0;
    addFlag(RISK_EVENT_ABV_UNKNOWN);
    if (ocrAbv != null) ocrAbvWithMissingCatalog = ocrAbv;
  }

  // ── Style: catalog value when known; otherwise unknown (stale styles purged) ──
  out.style = typeof record.style === "string" && record.style.trim() ? record.style.trim() : "";

  // ── Untappd: only a usable positive score may become a rating ──
  const usable =
    record.rating_usable === true && finitePositive(record.rating_raw) && finitePositive(record.rating_count);
  out.untappdId = record.untappd_id != null ? String(record.untappd_id) : null;
  out.untappdUrl = record.untappd_id != null ? `https://untappd.com/beer/${record.untappd_id}` : null;
  out.untappdScore = usable ? record.rating_raw : null;
  out.untappdRatingCount = usable ? record.rating_count : null;
  if (!usable) addFlag(RISK_EVENT_RATING_UNUSABLE);

  for (const issue of record.issues ?? []) {
    if (issue === "abv_database_disagreement") addFlag("ABV 来源存在未解决冲突");
  }

  const grounding = buildGroundingEvidence(record, { abvConflict, ocrAbvWithMissingCatalog, usable });
  out.evidence.push(grounding);
  if (abvConflict) {
    // Preserve the OCR side of the conflict as its own provenance entry too.
    out.evidence.push({
      source: "ocr",
      confidence: 0.5,
      summary: `ABV 冲突存证：OCR 菜单明示 ${abvConflict.ocr}%，整合活动目录 #${record.event_beer_id} 标 ${abvConflict.catalog}%；候选 ABV 字段暂取酒单值，分歧未消除。`,
    });
  }

  return out;
}

// ── Public pure entry point ──

/**
 * Ground assembled image candidates against the current event catalog.
 * Pure: inputs are never mutated. Unmatched/ambiguous candidates are returned
 * as-is (same reference); matched candidates get cloned, catalog-grounded
 * values plus venue_site evidence.
 */
export function groundMenuCandidates(
  candidates: BeerCandidate[],
  records: EventCatalogBeer[],
): BeerCandidate[] {
  if (!Array.isArray(candidates)) return [];
  if (!Array.isArray(records) || records.length === 0) return candidates.slice();

  const validRecords = records.filter(isEventCatalogBeer);
  if (validRecords.length === 0) return candidates.slice();

  return candidates.map(candidate => {
    const match = resolveMatch(candidate, validRecords);
    return match.status === "unique" ? applyGrounding(candidate, match.record) : candidate;
  });
}
