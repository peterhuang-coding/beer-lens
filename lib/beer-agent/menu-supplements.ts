/**
 * Curated menu supplement grounding (El Nido 2026-10 snapshot).
 *
 * Strict identity, like event-grounding:
 *   - normalized-exact name equal to menu_name / name_zh / canonical_name /
 *     explicit aliases (exact titles only)
 *   - when the OCR row supplies a brewery it must equal brewery / brewery_aliases
 *   - a unique result is required; duplicates stay unmatched
 *   - menuIndex / tap number NEVER participates in matching — a tap row is not
 *     evidence of identity
 *
 * The supplement is public-source social_web evidence, NOT an Untappd or
 * venue_site attribution. It carries no usable scores/IDs: every matched row
 * has inherited score/ID/URL/count cleared. Snapshot price/volume stay in the
 * OCR fields only and are never injected into evidence or another menu.
 *
 * Pure: inputs are never mutated. The file reader is fail-soft.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BeerCandidate, Evidence } from "./types";

// ── Catalog record shape (data/menus/elnido-2026-10.json) ──

export type SupplementSourceKind = "brewery" | "retailer" | "community";
export type SupplementIdentityStatus = "confirmed" | "version_unresolved" | "batch_unresolved";

export type MenuSupplementSource = {
  url: string;
  kind: SupplementSourceKind;
  access: "web_index_or_cache";
  checked_at: string;
  fields: string[];
};

export type MenuSupplementObservation = {
  abv: number | null;
  price: number | null;
  volume_ml: number | null;
  currency: "CNY";
  observed_at: string;
  source: "menu_transcription";
};

export type MenuSupplementEntry = {
  id: string;
  menu_index: number;
  menu_name: string;
  name_zh: string;
  brewery: string;
  brewery_aliases: string[];
  aliases: string[];
  identity_status: SupplementIdentityStatus;
  canonical_name: string | null;
  style: string | null;
  abv: number | null;
  description_zh: string;
  observation: MenuSupplementObservation;
  sources: MenuSupplementSource[];
  issues: string[];
  field_disagreements: Record<string, unknown>;
};

export type MenuSupplementFile = {
  version: number;
  menu_id: string;
  entries: MenuSupplementEntry[];
};

const SUPPLEMENT_SOURCE_KINDS = new Set<SupplementSourceKind>(["brewery", "retailer", "community"]);

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Observation numerics may be null, but NaN/Infinity/negative payloads never are. */
function isMenuSupplementObservation(value: unknown): value is MenuSupplementObservation {
  if (value === null || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  const nonNegFiniteOrNull = (v: unknown) => v === null || (finiteNumber(v) && v >= 0);
  return (
    nonNegFiniteOrNull(o.abv) &&
    nonNegFiniteOrNull(o.price) &&
    nonNegFiniteOrNull(o.volume_ml) &&
    o.currency === "CNY" &&
    typeof o.observed_at === "string" && o.observed_at.trim().length > 0 &&
    o.source === "menu_transcription"
  );
}

function isMenuSupplementSource(value: unknown): value is MenuSupplementSource {
  if (value === null || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.url === "string" && s.url.trim().length > 0 && /^https:\/\//.test(s.url.trim()) &&
    typeof s.kind === "string" && SUPPLEMENT_SOURCE_KINDS.has(s.kind as SupplementSourceKind) &&
    s.access === "web_index_or_cache" &&
    typeof s.checked_at === "string" && s.checked_at.trim().length > 0 &&
    Array.isArray(s.fields) && s.fields.length > 0 && s.fields.every(f => typeof f === "string")
  );
}

/** Structural guard at the read/apply boundary; one bad row never poisons the rest. */
function isMenuSupplementEntry(value: unknown): value is MenuSupplementEntry {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" && r.id.trim().length > 0 &&
    typeof r.menu_index === "number" && Number.isInteger(r.menu_index) &&
    typeof r.menu_name === "string" && r.menu_name.trim().length > 0 &&
    typeof r.name_zh === "string" &&
    typeof r.brewery === "string" && r.brewery.trim().length > 0 &&
    Array.isArray(r.brewery_aliases) && r.brewery_aliases.every(v => typeof v === "string") &&
    Array.isArray(r.aliases) && r.aliases.every(v => typeof v === "string") &&
    (r.identity_status === "confirmed" ||
      r.identity_status === "version_unresolved" ||
      r.identity_status === "batch_unresolved") &&
    (r.canonical_name === null || typeof r.canonical_name === "string") &&
    (r.style === null || typeof r.style === "string") &&
    (r.abv === null || finiteNumber(r.abv)) &&
    typeof r.description_zh === "string" &&
    isMenuSupplementObservation(r.observation) &&
    Array.isArray(r.sources) && r.sources.length > 0 && r.sources.every(isMenuSupplementSource) &&
    Array.isArray(r.issues) && r.issues.every(v => typeof v === "string") &&
    r.field_disagreements !== null && typeof r.field_disagreements === "object"
  );
}

/** Relative to process.cwd(); resolved per call so tests can chdir. */
export const MENU_SUPPLEMENT_RELATIVE_PATH = path.join("data", "menus", "elnido-2026-10.json");

/**
 * Fixed, known second supplement file: three rows from a SEPARATE undated
 * user-photo transcription (taps 1/10/16). There is deliberately no directory
 * scan or discovery — only this constant path is ever read.
 */
export const MENU_SUPPLEMENT_ADDITIONS_RELATIVE_PATH =
  path.join("data", "menus", "elnido-2026-10-additions.json");

/**
 * Fail-soft reader for one fixed supplement file. Missing file, malformed JSON,
 * non-object payload or unreadable rows degrade to an empty list, never throw.
 */
async function readSupplementFile(relativePath: string): Promise<MenuSupplementEntry[]> {
  try {
    const raw = await readFile(path.join(process.cwd(), "data", "menus", path.basename(relativePath)), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const entries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return [];
    return entries.filter(isMenuSupplementEntry);
  } catch {
    return [];
  }
}

/**
 * Fail-soft supplement reader for the fixed original file plus the fixed
 * additions file. The two reads are independent: a missing or broken additions
 * file (or the original) never poisons or blocks the other, and no arbitrary
 * file discovery happens. Original entries come first, additions after.
 */
export async function readMenuSupplements(): Promise<MenuSupplementEntry[]> {
  const [original, additions] = await Promise.all([
    readSupplementFile(MENU_SUPPLEMENT_RELATIVE_PATH),
    readSupplementFile(MENU_SUPPLEMENT_ADDITIONS_RELATIVE_PATH),
  ]);
  return [...original, ...additions];
}

// ── Strict matching ──

/** NFKC, lowercase, letters/numbers only (CJK / Cyrillic safe). */
function strictKey(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function nameKeys(entry: MenuSupplementEntry): Set<string> {
  const keys = new Set<string>();
  for (const value of [entry.menu_name, entry.name_zh, entry.canonical_name, ...entry.aliases]) {
    if (typeof value === "string" && value.trim()) {
      const key = strictKey(value);
      if (key) keys.add(key);
    }
  }
  return keys;
}

function breweryKeys(entry: MenuSupplementEntry): Set<string> {
  const keys = new Set<string>();
  for (const value of [entry.brewery, ...entry.brewery_aliases]) {
    if (typeof value === "string" && value.trim()) {
      const key = strictKey(value);
      if (key) keys.add(key);
    }
  }
  return keys;
}

type MatchResult =
  | { status: "unique"; entry: MenuSupplementEntry }
  | { status: "ambiguous" }
  | { status: "none" };

/** Identity is name (+ brewery when supplied) only; tap numbers never participate. */
function resolveMatch(candidate: BeerCandidate, entries: MenuSupplementEntry[]): MatchResult {
  const name = strictKey(candidate.displayName);
  if (!name) return { status: "none" };

  let hits = entries.filter(entry => nameKeys(entry).has(name));
  if (hits.length === 0) return { status: "none" };

  const brewery = strictKey(candidate.brewery);
  if (brewery) {
    const scoped = hits.filter(entry => breweryKeys(entry).has(brewery));
    if (scoped.length === 0) return { status: "none" }; // same name, other brewery
    if (scoped.length > 1) return { status: "ambiguous" };
    return { status: "unique", entry: scoped[0] };
  }

  if (hits.length === 1) return { status: "unique", entry: hits[0] };
  return { status: "ambiguous" };
}

// ── OCR-explicit ABV provenance ──
//
// Mirrors event-grounding's channel: the provider marks the menu-claimed ABV
// with OCR evidence before grounding, so a disagreement can be preserved as an
// OCR-vs-public-source conflict instead of a silent overwrite.

export const MENU_OBSERVATION_ABV_PREFIX = "菜单转录明示 ABV";
export const MENU_OBSERVATION_STYLE_PREFIX = "菜单转录明示风格";

export function ocrMenuAbvEvidence(abv: number, confidence = 0.6): Evidence {
  return {
    source: "ocr",
    confidence,
    summary: `${MENU_OBSERVATION_ABV_PREFIX} ${abv}%（菜单转录观察值，以公开来源核对为准）`,
  };
}

/**
 * Marks a style string actually read on the menu image. Unresolved rows may
 * retain a style ONLY through this channel; a style inherited from a stale
 * per-beer record has no such marker and is dropped.
 */
export function ocrMenuStyleEvidence(style: string, confidence = 0.6): Evidence {
  return {
    source: "ocr",
    confidence,
    summary: `${MENU_OBSERVATION_STYLE_PREFIX} ${style}（菜单转录观察，风格以公开来源核对为准）`,
  };
}

function readOcrExplicitAbv(candidate: BeerCandidate): number | null {
  const pattern = new RegExp(`(?:${MENU_OBSERVATION_ABV_PREFIX}|菜单明示酒精度)\\s*([0-9]+(?:\\.[0-9]+)?)\\s*%`);
  for (const entry of candidate.evidence ?? []) {
    if (entry?.source !== "ocr" || typeof entry.summary !== "string") continue;
    const match = pattern.exec(entry.summary);
    if (match) return Number(match[1]);
  }
  return null;
}

function readOcrExplicitStyle(candidate: BeerCandidate): string | null {
  const pattern = new RegExp(`${MENU_OBSERVATION_STYLE_PREFIX}\\s+(.+?)（菜单转录观察`);
  for (const entry of candidate.evidence ?? []) {
    if (entry?.source !== "ocr" || typeof entry.summary !== "string") continue;
    const match = pattern.exec(entry.summary);
    if (match) return match[1].trim();
  }
  return null;
}

// ── Risk flags / wording ──

// Wording is deliberately interoperable with the hard-constraint filter's
// /ABV.*(?:不一致|冲突)/ scan (recommendation/constraints.ts): an unresolved
// ABV conflict must read as a constraint failure, not just a soft flag.
export const RISK_SUPPLEMENT_ABV_CONFLICT = "公开来源 ABV 冲突：与菜单转录数值存在分歧（数值并存，未消除）";
export const RISK_SUPPLEMENT_VERSION_UNRESOLVED = "酒款版本未确认（菜单照片缺少版本标识，不迁移其他版本评分）";
export const RISK_SUPPLEMENT_BATCH_UNRESOLVED = "酒款批次/年份未确认（菜单未标注年份，不迁移特定批次评分）";
export const RISK_SUPPLEMENT_NO_RATING = "公开补充资料不含可用评分，继承的旧评分/ID/链接已清除";

/** Near-one-decimal-rounding tolerance: 6.66↔6.7, 19.25↔19.2 agree; 9↔9.1 does not. */
const ABV_ROUNDING_TOLERANCE = 0.06;

export type SupplementGroundingOutcome = {
  matched: true;
  menuId: string;
  entryId: string;
  identityStatus: SupplementIdentityStatus;
  evidence: Evidence;
};

/** Structured access to supplement provenance without new candidate fields. */
export function getSupplementGrounding(candidate: BeerCandidate): SupplementGroundingOutcome | null {
  for (let i = candidate.evidence.length - 1; i >= 0; i--) {
    const entry = candidate.evidence[i];
    if (entry.source !== "social_web") continue;
    const idMatch = /\[menu_supplement:([^\]]+)]/.exec(entry.summary ?? "");
    if (!idMatch) continue;
    const menuMatch = /\[menu_id:([^\]]+)]/.exec(entry.summary ?? "");
    const statusMatch = /\[identity_status:([^\]]+)]/.exec(entry.summary ?? "");
    return {
      matched: true,
      entryId: idMatch[1],
      menuId: menuMatch?.[1] ?? "",
      identityStatus: (statusMatch?.[1] ?? "confirmed") as SupplementIdentityStatus,
      evidence: entry,
    };
  }
  return null;
}

// ── Chinese rendering of curated issue tokens ──

const ISSUE_ZH: Record<string, string> = {
  untappd_and_official_distributor_hops_lists_differ_specific_hop_claims_omitted:
    "Untappd 与官方经销商页面的酒花清单不一致，本记录不采信任何具体酒花说法",
  kiwi_in_name_is_not_evidence_of_kiwifruit_ingredient:
    "酒名中的“Kiwi”不构成猕猴桃配料证据",
  no_exact_public_rating_located: "未检索到确切的公开评分",
  abv_disagreement_5_vs_4_9_recorded_no_exact_batch_claim:
    "ABV 公开来源存在 5% 与 4.9% 两种记载，不宣称对应具体批次",
  untappd_identity_url_listed_but_header_facts_not_verified:
    "Untappd 身份链接仅作身份参考，页头事实未核验",
  alias_origin_menu_short_title_girls_gone_equals_official_girls_gone_hazy:
    "菜单短标题“Girls Gone”被本地推断为官方酒款“Girls Gone Hazy”的简写别名（依据：标题+酒厂+7% ABV；官方页面确认 Girls Gone Hazy 为 7%，但未确认本店使用该短标题别名）",
  search_index_evidence_only_official_page_direct_open_failed:
    "证据仅来自搜索引擎索引，官网页面直连失败",
  do_not_apply_ivanych_2_0_rating_different_version:
    "不得套用“Иваныч 2.0”的评分，那是不同版本",
  third_party_site_rating_must_not_be_presented_as_untappd_no_ut_id_invented:
    "第三方站点评分不是 Untappd 评分，不杜撰 Untappd ID",
  menu_abv_6_7_is_one_decimal_rounding_of_source_6_66:
    "菜单 6.7% 为公开确切值 6.66% 的一位小数显示，并非不同版本",
  facts_embedded_in_public_venue_photo_page_no_personal_checkin_data_used:
    "事实嵌于公开酒单照片页，未使用任何个人打卡数据",
  "version_unresolved_photo_omits_#2": "照片未标注 #2，版本待确认",
  no_alias_or_score_transfer_from_bare_k_philia_to_k_philia_2:
    "不能把裸标题 K-philia 自动等同于 K-philia #2，也不迁移旧款评分",
  old_k_philia_8_5_imperial_oat_cream_ipa_is_a_different_beer:
    "旧款 K-philia 为 8.5% Imperial Oat Cream IPA，是另一款酒",
  cached_rating_snapshots_conflict_4_38_181_vs_4_289_943_no_usable_rating:
    "缓存评分快照互相冲突（4.38/181 与 4.289/943），不采用任何评分",
  exact_product_already_in_local_db_importer_preserves_existing_row_and_score:
    "本地酒库已有同一产品，导入时保留既有行与其历史评分",
  untappd_identity_linked_by_retailer_no_personal_data_used:
    "Untappd 身份由零售商页面链接，未使用个人数据",
  official_menu_page_search_index_only_live_html_is_js_shell_without_content:
    "官方菜单站仅有搜索索引证据，在线页面为无内容 JS 空壳",
  abv_conflict_9_vs_9_1_preserved_not_normalized:
    "ABV 9% 与 9.1% 的分歧原样保留，不作静默归一",
  distinct_from_old_double_blueberry_shake_no_old_score_transfer:
    "本款区别于旧款 Double Blueberry Shake，不迁移旧款评分",
  beeradvocate_mistaken_double_berry_description_rejected:
    "BeerAdvocate 误描述页（/beer/profile/41869/526417/）的“Double Berry”说法已拒绝采信，不作证据",
  earlier_visual_label_lil_big_was_wrong_corrected_to_big_pot:
    "早先视觉标签识别“Li'l Big”有误，已更正为 Big Pot",
  direct_product_url_returned_429_index_cache_only_no_retry:
    "产品直链返回 429，仅使用索引/缓存证据，不重试不绕行",
  batch_unresolved_menu_has_no_year: "菜单未标注年份/批次，批次待确认",
  no_2017_laroda_identity_or_score_transfer:
    "不迁移 2017 Laroda 批次的身份与评分",
  generic_series_page_5_vs_2017_laroda_6_kept_separate:
    "官方通用页 5% 与 2017 Laroda 批次 6% 分别保留",
  menu_abv_19_2_is_one_decimal_display_of_source_19_25:
    "菜单 19.2% 为公开确切值 19.25% 的一位小数显示",
  undated_reclaim_me_15_percent_is_a_different_beer:
    "未标年份的 Reclaim Me（15%）是另一款酒",
  four_barrel_sequence_on_photo_not_verified_by_source:
    "照片中的桶序信息未经来源核实",
  // ── 2026-10-24 additions (separate undated user-photo transcription) ──
  waldhaus_hop_origins_are_regions_not_verified_cultivars:
    "官方仅标明整颗酒花球果的产地（泰特南/施帕尔特/哈勒陶），产地表述不等于已核实的具体酒花品种",
  waldhaus_balanced_malty_is_producer_marketing_not_measured:
    "“均衡、饱满、麦芽感”为酒厂官方营销描述，非实测苦度或风味指标",
  waldhaus_bitterunits_4_is_flavor_scale_not_ibu:
    "官方风味刻度 Bitterunits 4 不是 IBU 苦度单位",
  producer_calls_it_a_classic_not_flagship_or_bestselling_claim:
    "“创始人年代延续的经典老款”为酒厂自述，不得表述为旗舰款或最畅销（获奖不等于旗舰，缺少旗舰或销量依据）",
  no_retail_price_captured_on_official_page:
    "官方页面未采集到零售价格",
  ddh_cactus_is_different_variant_no_ddh_process_or_hop_transfer:
    "酒厂官网的 DDH Cactus 是另一变体：不得把双倍干投工艺或其酒花说法迁移到本款 Cactus",
  bissell_collab_is_different_beer_its_hop_list_does_not_apply:
    "与 Bissell 的合酿是另一款酒：Amarillo/Citra/El Dorado/Mosaic 酒花清单不适用于本款",
  cactus_sensory_notes_are_community_listed_not_official_or_ingredients:
    "柔顺口感与菠萝/芒果/番石榴为社区条目所列感官描述，非官方品鉴词，也不构成水果配料证据",
  untappd_venue_page_displays_70_ibu_display_value_only_no_rating_used:
    "Untappd 场馆页显示 70 IBU 仅为页面显示值；本补充不采用任何评分",
  no_flagship_evidence_or_current_price_for_cactus:
    "无旗舰身份证据，也无当前价格证据",
  arpus_short_title_three_fruits_candidate_full_title_five_ingredients_version_unresolved:
    "照片短标题只列黑莓/蓝莓/芒果三种水果；可能候选全名另含菠萝与花生酱，版本未确认",
  arpus_pineapple_and_esp_peanut_butter_unconfirmed_no_ingredient_transfer:
    "菠萝与花生酱（尤其花生酱）为未确认配料，不得迁移到照片款或当作事实陈述",
  arpus_full_title_not_registered_as_confirmed_alias:
    "完整产品名未注册为短标题的确认别名",
  arpus_can_retail_offer_never_compared_with_bar_draft_no_fx_no_premium:
    "候选官方报价为不同形态的罐装零售（含税、运费另计、未采集汇率），不与照片中的酒吧生啤比价，不计算酒吧溢价，不产生 savingsVsOrigin",
};

function issueZh(issue: string): string {
  return ISSUE_ZH[issue] ?? `资料标记：${issue}`;
}

/** Render only ABV / identity / rating disagreements; snapshot price never leaks. */
function renderDisagreements(entry: MenuSupplementEntry): string[] {
  const out: string[] = [];
  const d = entry.field_disagreements ?? {};
  const abv = d.abv as Record<string, unknown> | undefined;
  if (abv && typeof abv === "object" && String(abv.resolution ?? "") !== "one_decimal_rounding") {
    const labelMap: Record<string, string> = {
      beeradvocate: "BeerAdvocate",
      tavour: "Tavour",
      brewery_order_page: "酒厂订购页",
      systembolaget: "Systembolaget",
      source_exact: "公开确切值",
      series_generic_page: "系列通用页",
      laroda_2017: "2017 Laroda 批次",
      old_k_philia: "旧款 K-philia",
      candidate_k_philia_2: "候选 K-philia #2",
      menu_observation: "菜单转录观察值",
    };
    const parts = Object.entries(abv)
      .filter(([k]) => k !== "resolution" && k !== "handling")
      .map(([k, v]) => `${labelMap[k] ?? k} ${v}%`);
    if (parts.length > 0) {
      out.push(`ABV 来源分歧：${parts.join("、")}；不同口径并存，勿确信单值`);
    }
  }
  const ratings = d.historical_rating_snapshots as Record<string, unknown> | undefined;
  if (ratings && typeof ratings === "object") {
    out.push("历史评分快照互相冲突且时间/版本不确定，本补充不提供任何评分");
  }
  const identity = d.identity as Record<string, unknown> | undefined;
  if (identity && typeof identity === "object") {
    const resolution = String(identity.resolution ?? "");
    if (resolution.includes("version_unresolved")) {
      // other_version is optional: a short title vs one longer candidate (e.g.
      // the undated Arpus photo) has no second known version to name.
      const other = String(identity.other_version ?? "");
      const otherClause = other ? `，另有“${other}”` : "";
      out.push(`身份未定：菜单标题为“${String(identity.menu_title ?? entry.menu_name)}”，可能是“${String(identity.candidate ?? "")}”${otherClause}，需人工确认`);
    } else if (resolution.includes("batch_unresolved")) {
      out.push(`批次未定：菜单为“${String(identity.menu ?? entry.menu_name)}”，来源另有日期批次“${String(identity.dated_source ?? "")}”，不假定年份`);
    }
  }
  return out;
}

function buildEvidence(
  entry: MenuSupplementEntry,
  context: { abvConflict: { ocr: number; canonical: number } | null; roundingNote: boolean },
): Evidence {
  // Dates are derived per row/per source, never hardcoded: the original 17
  // rows carry a dated 2026-10-20 snapshot; the additions rows carry a
  // separate undated-user-photo transcription and must stay distinct.
  const observedAt = entry.observation.observed_at;
  const datedSnapshot = /^\d{4}-\d{2}-\d{2}$/.test(observedAt);
  const checkedDates = [...new Set(entry.sources.map(s => s.checked_at))];
  const checkedLabel = checkedDates.length === 1
    ? (checkedDates[0] ?? "未知日期")
    : checkedDates.join("/");
  const rowLabel = datedSnapshot
    ? `${observedAt} 菜单转录行`
    : "未标日期用户照片转录行（独立于 2026-10-20 快照的另一次转录）";
  const title = entry.canonical_name && entry.canonical_name !== entry.menu_name
    ? `${entry.brewery} / ${entry.canonical_name}（菜单标题：${entry.menu_name}）`
    : `${entry.brewery} / ${entry.menu_name}`;

  const clauses: string[] = [];
  clauses.push(
    `公开资料补充 [menu_id:elnido-2026-10] [menu_supplement:${entry.id}] [identity_status:${entry.identity_status}]：${rowLabel} #${entry.menu_index} ${title}`,
  );
  clauses.push(`中文酒名：${entry.name_zh || "（无）"}`);
  clauses.push(`中文简介（公开资料意译）：${entry.description_zh}`);

  if (entry.identity_status === "confirmed") {
    if (entry.style) clauses.push(`公开规范风格：${entry.style}`);
    if (finiteNumber(entry.abv)) clauses.push(`公开规范 ABV ${entry.abv}%`);
    if (context.roundingNote && finiteNumber(entry.abv) && finiteNumber(entry.observation.abv)) {
      clauses.push(`菜单转录观察 ABV ${entry.observation.abv}% 为 ${entry.abv}% 的一位小数显示，非版本差异`);
    }
    if (context.abvConflict) {
      clauses.push(
        `ABV 分歧：菜单转录明示 ${context.abvConflict.ocr}%，公开规范值 ${context.abvConflict.canonical}%；候选字段保留菜单转录值，分歧未消除`,
      );
    }
  } else {
    clauses.push(
      entry.identity_status === "version_unresolved"
        ? "【版本未确认】仅保留菜单转录观察值，不套用规范风格/ABV，不附加任何评分、ID 或链接归因"
        : "【批次/年份未确认】仅保留菜单转录观察值与系列层面信息，不套用特定批次事实、评分或 ID",
    );
    if (finiteNumber(entry.observation.abv)) {
      clauses.push(`菜单转录观察 ABV ${entry.observation.abv}%（观察值，未经规范来源确认）`);
    }
  }

  for (const line of renderDisagreements(entry)) clauses.push(line);
  for (const issue of entry.issues ?? []) {
    if (typeof issue === "string" && issue) clauses.push(issueZh(issue));
  }

  const links = entry.sources.map(s => `${s.url}（${s.kind}，${s.access}，${s.checked_at} 核对）`);
  if (links.length > 0) clauses.push(`公开来源：${links.join("；")}`);
  if (datedSnapshot) {
    clauses.push(
      `适用范围：以上为 ${observedAt} El Nido 菜单转录快照配套的公开网页/索引资料（${checkedLabel} 核对），非 Untappd 评分归属、非现场核验，不代表实时库存或当前菜单；快照价格仅属于该菜单转录，不注入其他菜单。`,
    );
  } else {
    clauses.push(
      `适用范围：以上为另一份未标日期用户照片菜单转录配套的公开网页/索引资料（${checkedLabel} 核对）；该照片转录与 2026-10-20 El Nido 快照是相互独立的两次观察，不得互相替用，也不代表实时库存或当前菜单。非 Untappd 评分归属、非现场核验；照片转录价格仅属于该照片，不注入其他菜单，亦不与任何罐装/零售报价比较。`,
    );
  }
  clauses.push("本补充不含可用评分；该行继承的旧评分、Untappd ID 与链接均已清除，未经独立核验不得重建。");

  const hasConflict =
    context.abvConflict !== null ||
    (entry.issues ?? []).length > 0 ||
    Object.keys(entry.field_disagreements ?? {}).length > 0;
  const confidence =
    entry.identity_status === "confirmed" ? (hasConflict ? 0.6 : 0.85) : 0.55;

  return { source: "social_web", confidence, summary: clauses.join("；") };
}

/**
 * Evidence whose per-beer score/identity is invalidated by a matched
 * supplement: stale Untappd snippets and local per-beer cache/rating records
 * (provider emits these as `本地 <source> 酒款记录：…评分…`). Brewery-level
 * background snippets explicitly say 非本款评分 and are kept, as are OCR /
 * user / venue / other social evidence.
 */
function isInvalidatedPerBeerEvidence(e: Evidence): boolean {
  if (e?.source === "untappd") return true;
  if (e?.source === "agent_inference" && typeof e.summary === "string" &&
      /本地 \S+ 酒款记录：/.test(e.summary)) return true;
  return false;
}

function applyGrounding(candidate: BeerCandidate, entry: MenuSupplementEntry): BeerCandidate {
  // Read the explicit OCR channels off the ORIGINAL evidence; the markers are
  // OCR evidence and survive the invalidation prune below.
  const ocrAbv = readOcrExplicitAbv(candidate);
  const ocrStyle = readOcrExplicitStyle(candidate);

  const out: BeerCandidate = {
    ...candidate,
    evidence: candidate.evidence.filter(e => !isInvalidatedPerBeerEvidence(e)),
    riskFlags: [...candidate.riskFlags],
  };
  const addFlag = (flag: string) => {
    if (!out.riskFlags.includes(flag)) out.riskFlags.push(flag);
  };
  let abvConflict: { ocr: number; canonical: number } | null = null;
  let roundingNote = false;

  if (entry.identity_status === "confirmed") {
    // Canonical known style supersedes stale/missing guesses on unique identity.
    if (typeof entry.style === "string" && entry.style.trim()) out.style = entry.style.trim();

    if (finiteNumber(entry.abv)) {
      if (ocrAbv != null && finiteNumber(ocrAbv)) {
        const diff = Math.abs(ocrAbv - entry.abv);
        if (diff <= ABV_ROUNDING_TOLERANCE) {
          // 6.66 vs 6.7 / 19.25 vs 19.2: one-decimal display, canonical exact wins.
          out.abv = entry.abv;
          if (diff > 0) roundingNote = true;
        } else {
          // Real OCR-vs-source disagreement (e.g. 9.1 vs 9): preserve OCR value.
          out.abv = ocrAbv;
          abvConflict = { ocr: ocrAbv, canonical: entry.abv };
        }
      } else {
        // No explicit OCR claim: stale/missing ABV is superseded by canonical.
        out.abv = entry.abv;
      }
    }

    // Source-side ABV disagreements are always flagged, even when OCR agrees —
    // but an explained one-decimal rounding (6.66/6.7) is not a disagreement.
    const abvDisagreement = entry.field_disagreements?.abv as { resolution?: unknown } | undefined;
    if (abvDisagreement && String(abvDisagreement.resolution ?? "") !== "one_decimal_rounding") {
      addFlag(RISK_SUPPLEMENT_ABV_CONFLICT);
    }
  } else {
    // Unresolved: OCR only. A value is retained only when the provider marked
    // it as explicitly read on the image; legacy per-beer ABV/style from an
    // old record must never ride along. 0 / "" mean unknown, never 0% alcohol.
    out.abv = ocrAbv ?? 0;
    out.style = ocrStyle ?? "";
    if (entry.identity_status === "version_unresolved") addFlag(RISK_SUPPLEMENT_VERSION_UNRESOLVED);
    if (entry.identity_status === "batch_unresolved") addFlag(RISK_SUPPLEMENT_BATCH_UNRESOLVED);
  }

  if (abvConflict) addFlag(RISK_SUPPLEMENT_ABV_CONFLICT);

  // All matched rows: no score/ID/URL/count is established by this supplement.
  out.untappdId = null;
  out.untappdScore = null;
  out.untappdRatingCount = null;
  out.untappdUrl = null;
  // The identity/rating behind stale label art and old-record value estimates
  // is invalidated too. Current OCR price/volume stay. pricePerMl is kept only
  // when exactly reproducible from the current OCR price/volume; enrichment /
  // old-record estimates (no OCR provenance channel here) are dropped.
  out.labelImage = null;
  out.valueScore = null;
  out.originBenchmark = null;
  out.savingsVsOrigin = null;
  if (out.pricePerMl != null) {
    const fromOcr = out.price != null && out.volumeMl != null && out.volumeMl > 0
      ? out.price / out.volumeMl
      : null;
    if (fromOcr == null || !Number.isFinite(fromOcr) || Math.abs(fromOcr - out.pricePerMl) > 1e-9) {
      out.pricePerMl = null;
    }
  }
  addFlag(RISK_SUPPLEMENT_NO_RATING);

  out.evidence.push(buildEvidence(entry, { abvConflict, roundingNote }));
  return out;
}

// ── Public pure entry point ──

/**
 * Ground assembled image candidates against a curated menu supplement.
 * Pure: inputs are never mutated. Unmatched/ambiguous candidates are returned
 * as-is (same reference); matched candidates get cloned, publicly grounded
 * values plus a single social_web evidence entry.
 */
export function groundMenuSupplements(
  candidates: BeerCandidate[],
  entries: MenuSupplementEntry[],
): BeerCandidate[] {
  if (!Array.isArray(candidates)) return [];
  if (!Array.isArray(entries) || entries.length === 0) return candidates.slice();

  const validEntries = entries.filter(isMenuSupplementEntry);
  if (validEntries.length === 0) return candidates.slice();

  return candidates.map(candidate => {
    const match = resolveMatch(candidate, validEntries);
    return match.status === "unique" ? applyGrounding(candidate, match.entry) : candidate;
  });
}
