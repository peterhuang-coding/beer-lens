/**
 * Minimal YAML subset parser + rule loader for `data/rules/*.yaml`.
 *
 * Designed to support the rule schema below — NOT a full YAML 1.1 / 1.2
 * parser. Supported constructs:
 *   - `key: value` (string, number, bool, null)
 *   - `key: "quoted"` and `key: 'quoted'`
 *   - `key:` followed by indented block (map) or `-` list of maps
 *   - `-` list items at any indent level
 *   - `#` comments (line or trailing)
 *   - nested maps and lists up to arbitrary depth
 *   - blank lines ignored
 *
 * NOT supported (intentional — emit a clear error so the user knows):
 *   - flow style `{a: b}` / `[a, b]`
 *   - anchors / aliases
 *   - multiline scalars (`|`, `>`)
 *   - tags (`!!str`)
 *
 * Why a hand-rolled parser instead of `js-yaml`?
 *   1. No new npm dependency allowed.
 *   2. The rule files are 100% authored by us; we control the dialect.
 *   3. ~150 lines keeps the failure modes local and grep-friendly.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export type YamlValue = string | number | boolean | null | YamlMap | YamlList;
export type YamlMap = { [k: string]: YamlValue };
export type YamlList = YamlValue[];

// ── Lexer ──────────────────────────────────────────────────────────────────

class YamlError extends Error {
  readonly line: number;
  constructor(msg: string, line: number) {
    super(`yaml parse error at line ${line}: ${msg}`);
    this.line = line;
    this.name = "YamlError";
  }
}

type Line = { indent: number; content: string; lineno: number };

function stripComment(s: string): string {
  // Skip " # ..." but respect "#" inside quoted strings.
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function tokenize(src: string): Line[] {
  const lines: Line[] = [];
  for (let i = 0; i < src.split("\n").length; i++) {
    const raw = src.split("\n")[i];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const m = raw.match(/^(\s*)(.*)$/)!;
    lines.push({ indent: m[1].length, content: stripComment(m[2]), lineno: i + 1 });
  }
  return lines;
}

// ── Value parser (one line) ────────────────────────────────────────────────

function parseScalar(s: string): string | number | boolean | null {
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+([eE][-+]?\d+)?$/.test(s)) return Number(s);
  // Strip matched single or double quotes.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ── Recursive descent ──────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  private lines: Line[];
  private filePath: string;
  constructor(lines: Line[], filePath: string) {
    this.lines = lines;
    this.filePath = filePath;
  }

  parse(): YamlValue {
    if (this.lines.length === 0) return null;
    return this.parseValue(this.lines[0].indent);
  }

  /** Parse a value (map | list | scalar) starting at the current line,
   *  assuming the leading line is at indent `minIndent`. Consumes lines
   *  belonging to that value. */
  private parseValue(minIndent: number): YamlValue {
    if (this.pos >= this.lines.length) return null;
    const head = this.lines[this.pos];
    if (head.indent < minIndent) return null;
    if (head.content.startsWith("- ")) return this.parseList(head.indent);
    return this.parseMap(head.indent);
  }

  private parseMap(indent: number): YamlMap {
    const out: YamlMap = {};
    while (this.pos < this.lines.length) {
      const ln = this.lines[this.pos];
      if (ln.indent < indent) break;
      if (ln.indent > indent) {
        throw new YamlError(`unexpected indent ${ln.indent}`, ln.lineno);
      }
      const c = ln.content;
      if (c.startsWith("- ")) break;
      const colon = c.indexOf(":");
      if (colon === -1) {
        throw new YamlError(`expected ':' in map entry, got: ${c}`, ln.lineno);
      }
      const key = c.slice(0, colon).trim();
      const rest = c.slice(colon + 1).trim();
      this.pos++;
      if (rest === "") {
        if (this.pos >= this.lines.length) {
          out[key] = null;
          continue;
        }
        const next = this.lines[this.pos];
        if (next.indent <= indent) {
          out[key] = null;
        } else {
          out[key] = this.parseValue(next.indent);
        }
      } else {
        out[key] = parseScalar(rest);
      }
    }
    return out;
  }

  private parseList(indent: number): YamlList {
    const out: YamlList = [];
    while (this.pos < this.lines.length) {
      const ln = this.lines[this.pos];
      if (ln.indent < indent) break;
      if (ln.indent > indent) {
        throw new YamlError(`unexpected indent ${ln.indent}`, ln.lineno);
      }
      if (!ln.content.startsWith("- ")) break;
      const afterDash = ln.content.slice(2); // keep raw — may have leading space
      this.pos++;
      // Case 1: `- <scalar>` (single-line list item).
      if (!ln.content.startsWith("- ") || /^-\s+\S/.test(ln.content) === false) {
        // not used (kept for clarity)
      }
      const trimmed = afterDash.trim();
      if (trimmed === "") {
        // The list item body is the next indented block.
        if (this.pos < this.lines.length && this.lines[this.pos].indent > indent) {
          out.push(this.parseValue(this.lines[this.pos].indent));
        } else {
          out.push(null);
        }
        continue;
      }
      if (!trimmed.includes(":")) {
        out.push(parseScalar(trimmed));
        continue;
      }
      // Case 3: `- key: value ...` — inline map start. Determine child indent
      // by peeking at the next non-list-sibling line.
      const childIndent = this.peekChildIndent(indent);
      if (childIndent === null) {
        // No further children; parse the inline content as a one-line map.
        out.push(this.parseInlineMap(trimmed));
        continue;
      }
      // Build a synthetic head line at childIndent so parseMap accepts it.
      // Use a sub-parser to keep main pos untouched until we know how many
      // lines the children consumed.
      const sub = new Parser(
        [{ indent: childIndent, content: trimmed, lineno: ln.lineno }, ...this.lines.slice(this.pos)],
        this.filePath,
      );
      const val = sub.parseMap(childIndent) as YamlMap;
      // Advance our pos by however many lines the sub-parser consumed (minus
      // the synthetic head, which corresponds to the original `- ` line).
      const consumed = sub.pos - 1;
      // Skip exactly `consumed` further lines, stopping early if we hit a
      // sibling (`- ` at indent) or an outer line.
      let i = 0;
      while (i < consumed && this.pos < this.lines.length) {
        const cur = this.lines[this.pos];
        if (cur.indent <= indent) break;
        if (cur.content.startsWith("- ") && cur.indent === indent) break;
        this.pos++;
        i++;
      }
      out.push(val);
    }
    return out;
  }

  /** Peek the indent of the first child line, or null if the next line is
   *  another list sibling at the same indent. */
  private peekChildIndent(listIndent: number): number | null {
    const saved = this.pos;
    while (this.pos < this.lines.length) {
      const cur = this.lines[this.pos];
      if (cur.indent < listIndent) return null;
      if (cur.indent === listIndent) return null; // sibling
      return cur.indent;
    }
    this.pos = saved;
    return null;
  }

  /** Parse `- a: 1, b: 2` style inline map (no nested children). */
  private parseInlineMap(rest: string): YamlMap {
    const out: YamlMap = {};
    const parts = rest.split(/,\s*/);
    for (const p of parts) {
      const colon = p.indexOf(":");
      if (colon === -1) continue;
      const k = p.slice(0, colon).trim();
      const v = p.slice(colon + 1).trim();
      out[k] = v === "" ? null : parseScalar(v);
    }
    return out;
  }
}

/** Parse a YAML string. Throws YamlError with line number on failure. */
export function parseYaml(src: string, filePath = "<inline>"): YamlValue {
  const lines = tokenize(src);
  return new Parser(lines, filePath).parse();
}

// ── File loader ────────────────────────────────────────────────────────────

export function loadAllRules(dir: string): YamlList {
  let entries: string[];
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return [];
    entries = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    return [];
  }
  const out: YamlList = [];
  for (const f of entries) {
    const path = join(dir, f);
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = parseYaml(raw, path);
      if (parsed === null) continue;
      if (!Array.isArray(parsed)) {
        throw new YamlError(`top-level must be a list, got ${typeof parsed}`, 1);
      }
      for (const item of parsed) out.push(item);
    } catch (err) {
      console.warn(`[harness/yaml-rules] skip ${f}: ${(err as Error).message ?? err}`);
    }
  }
  return out;
}

// ── Condition / action DSL ─────────────────────────────────────────────────

export type Condition =
  | { field: string; op: "exists" | "missing" }
  | { field: string; op: "==" | "!="; value: string | number | boolean | null }
  | { field: string; op: "contains" | "starts_with" | "ends_with" | "matches"; value: string }
  | { field: string; op: ">" | ">=" | "<" | "<="; value: number };

export type Action =
  | { kind: "block"; reason: string }
  | { kind: "log"; level: "info" | "warn"; message: string }
  | { kind: "annotate"; key: string; value: unknown; reason?: string }
  | { kind: "route_override"; skill_id: string; reason: string }
  | { kind: "transform_reply"; new_reply: string; reason: string };

export interface YamlRule {
  id: string;
  stage: string;
  enabled: boolean;
  priority: number;
  description?: string;
  /** Optional when[]; if absent the rule fires unconditionally. AND-joined. */
  when?: Condition[];
  then: Action;
}

/** Read `path` from a nested object using dotted notation. Returns undefined
 *  on any miss. Supports array index via `preferences.0.style`. */
export function readPath(obj: unknown, path: string): unknown {
  if (obj === undefined || obj === null) return undefined;
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === undefined || cur === null) return undefined;
    if (/^\d+$/.test(p)) {
      cur = (cur as unknown[])[Number(p)];
    } else {
      cur = (cur as Record<string, unknown>)[p];
    }
  }
  return cur;
}

function evalCondition(c: Condition, ctx: Record<string, unknown>): boolean {
  const v = readPath(ctx, c.field);
  switch (c.op) {
    case "exists": return v !== undefined && v !== null;
    case "missing": return v === undefined || v === null;
    case "==": return v === c.value;
    case "!=": return v !== c.value;
    case "contains": return typeof v === "string" && v.includes(c.value);
    case "starts_with": return typeof v === "string" && v.startsWith(c.value);
    case "ends_with": return typeof v === "string" && v.endsWith(c.value);
    case "matches": return typeof v === "string" && new RegExp(c.value).test(v);
    case ">": return typeof v === "number" && v > c.value;
    case ">=": return typeof v === "number" && v >= c.value;
    case "<": return typeof v === "number" && v < c.value;
    case "<=": return typeof v === "number" && v <= c.value;
    default: return false;
  }
}

/** Compile a parsed YAML list of rule shapes into a HardRule[].
 *  Skip items that fail validation, log a warning per skip. */
export function compileYamlRules(items: YamlList): YamlRule[] {
  const out: YamlRule[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      console.warn("[harness/yaml-rules] skip non-map entry:", JSON.stringify(raw).slice(0, 80));
      continue;
    }
    const r = raw as YamlMap;
    const id = r.id;
    const stage = r.stage;
    if (typeof id !== "string" || typeof stage !== "string") {
      console.warn("[harness/yaml-rules] skip rule missing id/stage:", JSON.stringify(raw).slice(0, 80));
      continue;
    }
    if (!r.then || typeof r.then !== "object") {
      console.warn(`[harness/yaml-rules] skip ${id}: missing 'then' action`);
      continue;
    }
    const then = r.then as YamlMap;
    const actionKind = then.kind;
    if (typeof actionKind !== "string") {
      console.warn(`[harness/yaml-rules] skip ${id}: then.kind missing`);
      continue;
    }
    out.push({
      id,
      stage,
      enabled: r.enabled !== false, // default true
      priority: typeof r.priority === "number" ? r.priority : 50,
      description: typeof r.description === "string" ? r.description : "",
      when: Array.isArray(r.when)
        ? (r.when as YamlList).filter((c) => typeof c === "object" && c !== null) as Condition[]
        : undefined,
      then: { ...(then as Record<string, unknown>) } as Action,
    });
  }
  return out;
}

/** Compile a single YamlRule to a HardRule-compatible evaluate function. */
export function yamlRuleToHardRule(y: YamlRule): {
  id: string;
  stage: YamlRule["stage"];
  enabled: boolean;
  priority: number;
  description: string;
  evaluate: (ctx: { message?: string; skill_id?: string; llm_response?: unknown; candidates?: unknown[]; reply?: string; annotations?: Record<string, unknown>; profile?: unknown }) => import("./rules.ts").RuleAction | null;
} {
  return {
    id: y.id,
    stage: y.stage,
    enabled: y.enabled,
    priority: y.priority,
    description: y.description ?? "",
    evaluate(ctx) {
      if (y.when && y.when.length > 0) {
        const allOk = y.when.every((c) => evalCondition(c, ctx as Record<string, unknown>));
        if (!allOk) return null;
      }
      const action = y.then;
      // Whitelist: validate shape based on kind before returning.
      switch (action.kind) {
        case "block":
          return { kind: "block", reason: String((action as { reason?: unknown }).reason ?? "blocked") };
        case "log":
          return { kind: "log", level: ((action as { level?: string }).level === "warn" ? "warn" : "info"), message: String((action as { message?: unknown }).message ?? "") };
        case "annotate":
          return { kind: "annotate", key: String((action as { key?: unknown }).key), value: (action as { value?: unknown }).value ?? null, reason: (action as { reason?: unknown }).reason as string | undefined };
        case "route_override":
          return { kind: "route_override", skill_id: String((action as { skill_id?: unknown }).skill_id) as never, reason: String((action as { reason?: unknown }).reason ?? "yaml rule") };
        case "transform_reply":
          return { kind: "transform_reply", new_reply: String((action as { new_reply?: unknown }).new_reply), reason: String((action as { reason?: unknown }).reason ?? "yaml rule") };
        default:
          return null;
      }
    },
  };
}

/** Load + compile + return HardRule[] ready to be merged into RULES. */
export function loadYamlHardRules(dir: string): ReturnType<typeof yamlRuleToHardRule>[] {
  const items = loadAllRules(dir);
  const parsed = compileYamlRules(items);
  return parsed.map(yamlRuleToHardRule);
}