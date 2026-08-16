/**
 * lib/crawler/selector-probe.ts
 *
 * Selector drift monitoring — pure functions, stdlib only.
 *
 * The crawler layer (untappd-selectors.ts / ratebeer-selectors.ts) defines
 * the canonical selector tables that drive BeerRecord parsing. When a site
 * ships a redesign, those selectors silently stop matching and the parser
 * starts returning nulls. This module probes the same selectors against
 * captured HTML and exposes:
 *
 *   - PROBE_TARGETS : declarative list of every selector worth probing
 *   - runProbe()    : given HTML + source + surface, return match counts
 *                     + 3 sample snippets for each probe target
 *   - detectDrift() : given baseline + latest probe results, emit drift
 *                     records when match counts move more than 20%
 *
 * No cheerio / playwright (per the goal redline "不引 playwright,用
 * cheerio / 正则就够"). The untappd CSS-like selectors are translated to
 * regex on the fly; ratebeer regexes are used verbatim.
 */

import {
  DETAIL_SELECTORS,
  LIST_SELECTORS,
} from "./untappd-selectors.ts";
import {
  DETAIL_ABV_RE,
  DETAIL_BREWERY_RE,
  DETAIL_NAME_RE,
  DETAIL_RATING_COUNT_RE,
  DETAIL_RATING_RE,
  DETAIL_STYLE_RE,
  LIST_BEER_LINK_RE,
} from "./ratebeer-selectors.ts";

/* ─────────────────────────── types ─────────────────────────── */

export type Source = "untappd" | "ratebeer";
/** Page kind the probe target lives on. */
export type Surface = "list" | "detail";

export type ProbeKind = "css" | "regex";

export interface ProbeTarget {
  /** Stable id used in baseline / dashboard. */
  id: string;
  source: Source;
  surface: Surface;
  /** Human-readable name shown in the matrix. */
  name: string;
  kind: ProbeKind;
  /**
   * For css targets: the CSS-like selector string from
   * untappd-selectors.ts. For regex targets: the *source* of the
   * RegExp (we rebuild it inside runProbe to avoid lastIndex bleed).
   */
  pattern: string;
  /** RegExp flags to use when rebuilding. */
  flags?: string;
  /** Short label for the matrix column header. */
  group?: string;
}

export interface ProbeResult {
  id: string;
  source: Source;
  surface: Surface;
  name: string;
  matched: number;
  /** Up to 3 short matched snippets for human inspection. */
  sample: string[];
}

export interface DriftEntry {
  id: string;
  source: Source;
  surface: Surface;
  name: string;
  baseline_matched: number;
  latest_matched: number;
  /** Absolute difference as a fraction of baseline (0.0 - 1.0+). */
  delta_ratio: number;
  ts: string;
  drift: true;
}

/* ──────────────────────── CSS → regex helper ───────────────── */

/**
 * Translate a tiny subset of CSS selectors (the only shapes the
 * untappd table uses) into a case-insensitive regex over an HTML
 * string. Supports:
 *
 *   .className          → element with that class
 *   #id                 → element with that id
 *   tag                 → element name
 *   [attr]              → element with attribute present
 *   [attr="value"]      → element with attribute = "value"
 *   [attr*="value"]     → element with attribute containing "value"
 *   compound (a[href*="/beer/"]) — tag + attr combo
 *   comma (".beer-name, .name") — alternation
 *
 * Note: this is intentionally limited. The goal is "does the markup
 * still contain any element matching this selector?" — exact DOM
 * semantics aren't required.
 */
function cssToRegex(selector: string): RegExp {
  const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);

  const alternatives = parts.map((part) => {
    // tokenize: tag?, ([.#]identifier | [attr...])+
    const tokens: string[] = [];
    let i = 0;
    let tag = "";
    while (i < part.length && /[a-zA-Z]/.test(part[i]!)) {
      tag += part[i]!;
      i++;
    }
    if (tag) tokens.push(`tag:${tag}`);

    while (i < part.length) {
      const ch = part[i]!;
      if (ch === ".") {
        let j = i + 1;
        while (j < part.length && /[a-zA-Z0-9_-]/.test(part[j]!)) j++;
        tokens.push(`class:${part.slice(i + 1, j)}`);
        i = j;
      } else if (ch === "#") {
        let j = i + 1;
        while (j < part.length && /[a-zA-Z0-9_-]/.test(part[j]!)) j++;
        tokens.push(`id:${part.slice(i + 1, j)}`);
        i = j;
      } else if (ch === "[") {
        const close = part.indexOf("]", i);
        if (close === -1) {
          i = part.length;
          break;
        }
        const attr = part.slice(i + 1, close).trim();
        tokens.push(`attr:${attr}`);
        i = close + 1;
      } else {
        // unknown char — skip
        i++;
      }
    }

    const frag = tokens.map((tok) => {
      const [kind, body] = tok.split(":", 2);
      if (kind === "tag") {
        return `<${body}\\b`;
      }
      if (kind === "class") {
        return `<[^>]*\\bclass\\s*=\\s*"[^"]*\\b${escapeRe(body)}\\b`;
      }
      if (kind === "id") {
        return `<[^>]*\\bid\\s*=\\s*"${escapeRe(body)}"`;
      }
      if (kind === "attr") {
        // [attr] / [attr="v"] / [attr*="v"]
        const m = body.match(/^([a-zA-Z_-]+)(\*?=)["']?([^"']*)["']?$/);
        if (!m) return `<[^>]*${escapeRe(body)}=`;
        const [, attrName, op, attrVal] = m;
        if (op === "") return `<[^>]*\\b${attrName}\\s*=\\s*"`;
        if (op === "=") {
          return `<[^>]*\\b${attrName}\\s*=\\s*"${escapeRe(attrVal ?? "")}"`;
        }
        // "*=" contains
        return `<[^>]*\\b${attrName}\\s*=\\s*"[^"]*${escapeRe(attrVal ?? "")}[^"]*"`;
      }
      return "";
    }).join("[^>]*");

    // Close tag fragment with a > and allow whitespace inside.
    return `${frag}\\b[^>]*>`;
  });

  const joined = alternatives.map((a) => `(?:${a})`).join("|");
  return new RegExp(joined, "gi");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ──────────────────────── PROBE_TARGETS ────────────────────── */

/**
 * Every selector worth probing. Derived directly from
 * untappd-selectors.ts + ratebeer-selectors.ts so a refactor that
 * adds a new selector shows up here automatically. Keep the id
 * stable — the dashboard joins on it.
 */
export const PROBE_TARGETS: ProbeTarget[] = [
  /* untappd — list page */
  {
    id: "untappd.list.item",
    source: "untappd",
    surface: "list",
    name: "LIST_SELECTORS.item",
    kind: "css",
    pattern: LIST_SELECTORS.item,
    group: "list",
  },
  {
    id: "untappd.list.id",
    source: "untappd",
    surface: "list",
    name: "LIST_SELECTORS.id",
    kind: "css",
    pattern: LIST_SELECTORS.id,
    group: "list",
  },
  {
    id: "untappd.list.name",
    source: "untappd",
    surface: "list",
    name: "LIST_SELECTORS.name",
    kind: "css",
    pattern: LIST_SELECTORS.name,
    group: "list",
  },
  {
    id: "untappd.list.url",
    source: "untappd",
    surface: "list",
    name: "LIST_SELECTORS.url",
    kind: "css",
    pattern: LIST_SELECTORS.url,
    group: "list",
  },
  /* untappd — detail page (5 tabs) */
  {
    id: "untappd.detail.info",
    source: "untappd",
    surface: "detail",
    name: "DETAIL_SELECTORS.info",
    kind: "css",
    pattern: DETAIL_SELECTORS.info,
    group: "detail",
  },
  {
    id: "untappd.detail.ratings",
    source: "untappd",
    surface: "detail",
    name: "DETAIL_SELECTORS.ratings",
    kind: "css",
    pattern: DETAIL_SELECTORS.ratings,
    group: "detail",
  },
  {
    id: "untappd.detail.tags",
    source: "untappd",
    surface: "detail",
    name: "DETAIL_SELECTORS.tags",
    kind: "css",
    pattern: DETAIL_SELECTORS.tags,
    group: "detail",
  },
  {
    id: "untappd.detail.food",
    source: "untappd",
    surface: "detail",
    name: "DETAIL_SELECTORS.food",
    kind: "css",
    pattern: DETAIL_SELECTORS.food,
    group: "detail",
  },
  {
    id: "untappd.detail.similar",
    source: "untappd",
    surface: "detail",
    name: "DETAIL_SELECTORS.similar",
    kind: "css",
    pattern: DETAIL_SELECTORS.similar,
    group: "detail",
  },
  /* ratebeer — list */
  {
    id: "ratebeer.list.beer-link",
    source: "ratebeer",
    surface: "list",
    name: "LIST_BEER_LINK_RE",
    kind: "regex",
    pattern: LIST_BEER_LINK_RE.source,
    flags: LIST_BEER_LINK_RE.flags,
    group: "list",
  },
  /* ratebeer — detail */
  {
    id: "ratebeer.detail.name",
    source: "ratebeer",
    surface: "detail",
    name: "DETAIL_NAME_RE",
    kind: "regex",
    pattern: DETAIL_NAME_RE.source,
    flags: DETAIL_NAME_RE.flags,
    group: "detail",
  },
  {
    id: "ratebeer.detail.rating",
    source: "ratebeer",
    surface: "detail",
    name: "DETAIL_RATING_RE",
    kind: "regex",
    pattern: DETAIL_RATING_RE.source,
    flags: DETAIL_RATING_RE.flags,
    group: "detail",
  },
  {
    id: "ratebeer.detail.rating-count",
    source: "ratebeer",
    surface: "detail",
    name: "DETAIL_RATING_COUNT_RE",
    kind: "regex",
    pattern: DETAIL_RATING_COUNT_RE.source,
    flags: DETAIL_RATING_COUNT_RE.flags,
    group: "detail",
  },
  {
    id: "ratebeer.detail.abv",
    source: "ratebeer",
    surface: "detail",
    name: "DETAIL_ABV_RE",
    kind: "regex",
    pattern: DETAIL_ABV_RE.source,
    flags: DETAIL_ABV_RE.flags,
    group: "detail",
  },
  {
    id: "ratebeer.detail.style",
    source: "ratebeer",
    surface: "detail",
    name: "DETAIL_STYLE_RE",
    kind: "regex",
    pattern: DETAIL_STYLE_RE.source,
    flags: DETAIL_STYLE_RE.flags,
    group: "detail",
  },
  {
    id: "ratebeer.detail.brewery",
    source: "ratebeer",
    surface: "detail",
    name: "DETAIL_BREWERY_RE",
    kind: "regex",
    pattern: DETAIL_BREWERY_RE.source,
    flags: DETAIL_BREWERY_RE.flags,
    group: "detail",
  },
];

/* ─────────────────────── runProbe ─────────────────────────── */

/** Cap how many sample snippets we collect per target. */
const SAMPLE_LIMIT = 3;

function snippet(s: string, max = 80): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + "…";
}

/**
 * Run every probe target for (source, surface) against the given HTML.
 * Returns ProbeResult[] in PROBE_TARGETS order.
 */
export function runProbe(
  html: string,
  source: Source,
  surface: Surface,
): ProbeResult[] {
  const targets = PROBE_TARGETS.filter(
    (t) => t.source === source && t.surface === surface,
  );
  const out: ProbeResult[] = [];
  for (const t of targets) {
    out.push(probeOne(html, t));
  }
  return out;
}

function probeOne(html: string, t: ProbeTarget): ProbeResult {
  const re = t.kind === "css"
    ? cssToRegex(t.pattern)
    : new RegExp(t.pattern, t.flags ?? "gi");

  let matched = 0;
  const sample: string[] = [];
  let m: RegExpExecArray | null;
  // Reset lastIndex defensively in case caller reused the regex.
  re.lastIndex = 0;
  while ((m = re.exec(html)) !== null) {
    matched++;
    if (sample.length < SAMPLE_LIMIT) {
      const hit = m[0] ?? "";
      sample.push(snippet(hit));
    }
    // Guard against zero-width match infinite loop.
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return {
    id: t.id,
    source: t.source,
    surface: t.surface,
    name: t.name,
    matched,
    sample,
  };
}

/** Export for tests / docs — keep the helper visible. */
export { cssToRegex };

/* ─────────────────────── detectDrift ──────────────────────── */

/** Threshold above which we declare drift. */
export const DRIFT_THRESHOLD = 0.20;

/**
 * Compare baseline + latest ProbeResult arrays and return DriftEntry[]
 * for every target whose match count moved more than DRIFT_THRESHOLD
 * from the baseline. A target missing from baseline is also a drift
 * (treated as 100% drop).
 */
export function detectDrift(
  baseline: ProbeResult[],
  latest: ProbeResult[],
  now: Date = new Date(),
): DriftEntry[] {
  const baseById = new Map(baseline.map((r) => [r.id, r]));
  const drifts: DriftEntry[] = [];
  const ts = now.toISOString();
  for (const cur of latest) {
    const base = baseById.get(cur.id);
    if (!base) continue;
    if (base.matched === 0 && cur.matched === 0) continue;
    let delta: number;
    if (base.matched === 0) {
      delta = cur.matched === 0 ? 0 : 1;
    } else {
      delta = Math.abs(cur.matched - base.matched) / base.matched;
    }
    if (delta > DRIFT_THRESHOLD) {
      drifts.push({
        id: cur.id,
        source: cur.source,
        surface: cur.surface,
        name: cur.name,
        baseline_matched: base.matched,
        latest_matched: cur.matched,
        delta_ratio: delta,
        ts,
        drift: true,
      });
    }
  }
  return drifts;
}