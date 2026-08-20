/**
 * Hard rules — TS functions that run at specific stages of the harness
 * pipeline and can override, block, filter, annotate, or log.
 *
 * Why TS and not a YAML DSL?
 *   - Type safety: every rule gets the full TypeScript type-check at build.
 *   - IDE support: rename / go-to-definition / find-references just work.
 *   - No parser: rules ship as plain async functions; no `eval()` or YAML
 *     loader that could mask runtime errors.
 *
 * Each rule:
 *   - `id`        — unique slug used by Stats and the Rules tab.
 *   - `stage`     — which stage fires it (see `Stage` below).
 *   - `enabled`   — boolean toggle, mutable via /api/debug/rules/[id] PATCH.
 *   - `priority`  — higher runs first; ties broken by insertion order.
 *   - `description` — short sentence shown in the Rules tab.
 *   - `evaluate(ctx)` — pure function returning a RuleAction | null.
 *
 * `ctx` is whatever the calling stage chose to pass. For now rules only
 * look at a small allow-list of fields and tolerate missing keys, so a
 * rule written today still compiles after we extend the stage payloads.
 */

import type { SkillId } from "./types.ts";

/**
 * The 10 hook points exposed by the harness. Each stage corresponds to
 * one `runRulesForStage(stage, ctx)` call site somewhere in
 * lib/harness/{router,rules-engine,...}.ts and lib/skills/*.
 */
export type Stage =
  | "pre-route"
  | "post-route"
  | "pre-skill"
  | "post-skill"
  | "pre-llm"
  | "post-llm"
  | "pre-vision"
  | "post-vision"
  | "pre-memory-read"
  | "post-memory-read"
  | "pre-memory-write"
  | "post-memory-write";

export type RuleAction =
  | { kind: "route_override"; skill_id: SkillId; reason: string }
  | { kind: "filter_candidates"; predicate: "fresh_only" | "high_score"; reason: string }
  | { kind: "annotate"; key: string; value: unknown; reason?: string }
  | { kind: "block"; reason: string }
  | { kind: "log"; level: "info" | "warn"; message: string }
  /** Post-skill only — rewrite the user-visible reply text. Engine never
   *  mutates candidates/picks, only the string that streams to the UI. */
  | { kind: "transform_reply"; new_reply: string; reason: string }
  /** Pre-llm only — if the LLM provider supports it, retry once with this
   *  hint appended to the system prompt. The engine emits a synthetic
   *  "llm:retry" stage so the trace shows both attempts. */
  | { kind: "retry_llm_with_hint"; hint: string; max_attempts?: number; reason: string };

export interface RuleCtx {
  /** The user message that triggered this stage. */
  message?: string;
  /** The skill id picked so far (post-route stages only). */
  skill_id?: SkillId | string;
  /** Routing source: "rule" | "llm" | "none" | "error". */
  source?: "rule" | "llm" | "none" | "error";
  /** LLM response object (post-llm only). */
  llm_response?: unknown;
  /** Skill result candidates (post-skill only). */
  candidates?: unknown[];
  /** The skill's user-visible reply (post-skill only). */
  reply?: string;
  /** Free-form annotations other rules have already attached. */
  annotations?: Record<string, unknown>;
  /** Profile summary (post-memory-read of profileSummary). */
  profile?: { preferredStyles?: Array<{ style: string; weight: number }>; confidence?: number };
}

export interface HardRule {
  id: string;
  stage: Stage;
  enabled: boolean;
  priority: number;
  description: string;
  /** Pure function: receive the stage context, return an action or null. */
  evaluate(ctx: RuleCtx): RuleAction | null;
}

// ── Starter rules (5) ───────────────────────────────────────────────────────

const RULES: HardRule[] = [
  // 1. Image OCR freshness — flag stale label reads so the user (and
  //    downstream rule #2) can see it.
  {
    id: "image-ocr-freshness",
    stage: "post-llm",
    enabled: true,
    priority: 100,
    description: "When label-check LLM reports freshnessAssessment === 'stale', annotate the request.",
    evaluate(ctx) {
      const r = ctx.llm_response as { freshnessAssessment?: string } | undefined;
      if (r?.freshnessAssessment === "stale") {
        return {
          kind: "annotate",
          key: "label_check.freshness",
          value: "stale",
          reason: "label-check reported stale freshness",
        };
      }
      return null;
    },
  },

  // 2. Cross-skill block — if a prior label check marked the candidate
  //    stale, refuse to recommend it. Demonstrates cross-stage data flow.
  {
    id: "cross-skill-freshness-block",
    stage: "pre-skill",
    enabled: true,
    priority: 90,
    description: "If label_check.freshness === stale and skill is menu_recommend, block with a hint.",
    evaluate(ctx) {
      const freshness = ctx.annotations?.["label_check.freshness"];
      if (freshness === "stale" && ctx.skill_id === "menu_recommend") {
        return {
          kind: "block",
          reason: "刚才检查的酒标新鲜度不够,请换一款再让我推荐。",
        };
      }
      return null;
    },
  },

  // 3. Profile bias annotation — when a user's preferred style weight
  //    exceeds 0.6, surface it so the UI can show "based on your love
  //    of NEIPA".
  {
    id: "memory-style-bias-annotate",
    stage: "post-memory-read",
    enabled: true,
    priority: 80,
    description: "If profile.preferredStyles[0].weight > 0.6, annotate bias_style.",
    evaluate(ctx) {
      const top = ctx.profile?.preferredStyles?.[0];
      if (top && top.weight > 0.6) {
        return {
          kind: "annotate",
          key: "profile.bias_style",
          value: top.style,
          reason: `profile bias ${top.style} (weight ${top.weight.toFixed(2)})`,
        };
      }
      return null;
    },
  },

  // 4. Routing override — when the user says "fresh" / "新鲜" but the
  //    router picked unclear, send them to label_check instead.
  {
    id: "routing-freshness-pre-override",
    stage: "pre-route",
    enabled: true,
    priority: 70,
    description: "If message mentions 新鲜 / freshness AND router source is unclear, route to label_check.",
    evaluate(ctx) {
      const m = ctx.message ?? "";
      const hitFresh = m.includes("新鲜") || /freshness/i.test(m);
      const unclearish = !ctx.skill_id || ctx.skill_id === "unclear" || ctx.source === "none";
      if (hitFresh && unclearish) {
        return {
          kind: "route_override",
          skill_id: "label_check",
          reason: "user mentions 新鲜 but router picked unclear → label_check",
        };
      }
      return null;
    },
  },

  // 5. Low-confidence LLM route warning — give Stats a "suspicious
  //    routes" counter.
  {
    id: "low-confidence-route-warn",
    stage: "post-route",
    enabled: true,
    priority: 60,
    description: "If LLM router was used and confidence < 0.4, log a warning.",
    evaluate(ctx) {
      if (ctx.source === "llm") {
        const conf = (ctx as RuleCtx & { _confidence?: number })._confidence ?? 0.5;
        if (conf < 0.4) {
          return {
            kind: "log",
            level: "warn",
            message: `LLM low-confidence route to ${ctx.skill_id ?? "?"}`,
          };
        }
      }
      return null;
    },
  },

  // 6. Post-skill reply polish — append a tiny note when the reply looks
  //    terse (no punctuation, short). Demonstrates the new transform_reply
  //    action. Keep low priority so user-specific rules win if added later.
  {
    id: "polish-short-reply",
    stage: "post-skill",
    enabled: true,
    priority: 10,
    description: "If skill reply < 8 chars, append a friendly line via transform_reply.",
    evaluate(ctx) {
      const r = (ctx.reply ?? "").trim();
      if (r.length > 0 && r.length < 8 && ctx.skill_id) {
        return {
          kind: "transform_reply",
          new_reply: r + " — 还想知道哪一款的细节?",
          reason: "short reply polish",
        };
      }
      return null;
    },
  },

  // 7. Pre-llm retry hint — when LLM classifies a request to "unclear" but
  //    the user message contains obvious menu words, hint the next attempt
  //    to lean harder toward menu_recommend. Demonstrates retry_llm_with_hint.
  {
    id: "retry-llm-unclear-lean-menu",
    stage: "pre-llm",
    enabled: true,
    priority: 50,
    description: "If pre-llm context suggests an unclear route, hint retry toward menu_recommend.",
    evaluate(ctx) {
      const m = ctx.message ?? "";
      const hitMenu = /(酒单|菜单|挑一杯|点一杯|推荐|tap\s*list)/i.test(m);
      if (hitMenu) {
        return {
          kind: "retry_llm_with_hint",
          hint: "If unsure between menu_recommend and other skills, prefer menu_recommend when the user mentions 酒单/菜单/挑一杯/点一杯.",
          max_attempts: 1,
          reason: "menu word detected; hint retry toward menu_recommend",
        };
      }
      return null;
    },
  },
];

export function listRules(): HardRule[] {
  return RULES.slice();
}

export function findRule(id: string): HardRule | undefined {
  return RULES.find((r) => r.id === id);
}

export function setRuleEnabled(id: string, enabled: boolean): HardRule | null {
  const r = findRule(id);
  if (!r) return null;
  r.enabled = enabled;
  return r;
}

/** Merge YAML-defined rules into RULES. Existing rule with the same id wins. */
export function mergeYmlRules(yamlRules: HardRule[]): number {
  let added = 0;
  for (const y of yamlRules) {
    if (findRule(y.id)) continue;
    RULES.push(y);
    added++;
  }
  return added;
}

// Test helper: snapshot current enabled flags so a test can restore them.
export function _snapshotEnabled(): Record<string, boolean> {
  return Object.fromEntries(RULES.map((r) => [r.id, r.enabled]));
}

export function _restoreEnabled(snap: Record<string, boolean>): void {
  for (const r of RULES) {
    if (snap[r.id] !== undefined) r.enabled = snap[r.id];
  }
}

// Test helper: add a rule (returns true if added, false if id collision).
export function _addRuleForTest(rule: HardRule): boolean {
  if (findRule(rule.id)) return false;
  RULES.push(rule);
  return true;
}

// Test helper: remove a rule by id.
export function _removeRuleForTest(id: string): boolean {
  const idx = RULES.findIndex((r) => r.id === id);
  if (idx < 0) return false;
  RULES.splice(idx, 1);
  return true;
}
