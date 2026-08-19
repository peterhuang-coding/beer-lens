/**
 * Harness Router — keyword rule fast-path.
 *
 * Lives in its own module so it can be imported by `routeByLLM` AND by
 * tests that don't want to drag in the OpenAI-compat provider (whose
 * TypeScript uses parameter-property syntax not supported by
 * `node --experimental-strip-types`).
 *
 * The rules cover the most common Chinese beer-related intents. Anything
 * not matched here falls through to the LLM classifier.
 */

import { listSkills } from "./router.ts";
import type { SkillId } from "./types.ts";
import type { RouteDecision } from "./llm/prompts/intent-classifier.ts";
import { appendStage } from "./trace-buffer.ts";

interface Rule {
  skill: SkillId;
  /** Match if ANY keyword (lowercased substring) appears in the message. */
  keywords: string[];
  /** Params extractor — pulled from the message when the rule fires. */
  params?: (msg: string) => Record<string, unknown>;
}

// Rule priority: more-specific intents win over generic recommendation.
// The first matching rule wins, so we order intent verbs before the
// catch-all style-name match in menu_recommend.
const RULES: Rule[] = [
  // 1. Knowledge questions ("什么是 NEIPA" / "为什么") win over recommendation
  //    even when the question contains a style name.
  {
    skill: "beer_knowledge",
    keywords: ["什么是", "为什么", "区别", "怎么", "如何酿", "介绍一下", "介绍下"],
    params: (msg) => ({ question: msg }),
  },
  // 2. Memory corrections — the user is changing their preferences.
  {
    skill: "memory_correction",
    keywords: ["我其实", "其实不喜欢", "其实喜欢", "更正", "以后不要", "更新一下", "改一下", "重新记"],
    params: (msg) => ({ correction: msg }),
  },
  // 3. Tasting feedback — "刚喝了一款..." / "记一下" / "尝了".
  //    IMPORTANT: do NOT include "味道" here — it matches future-tense
  //    "想要味道浓郁的" (recommend intent) and breaks that route.
  {
    skill: "tasting_feedback",
    keywords: ["喝过", "尝了", "感觉", "口感", "反馈", "记一下", "记一笔", "记下来", "刚喝", "喝了", "今天喝了"],
    params: (msg) => ({
      notes: msg,
      sentiment: msg.match(/好喝|不错|喜欢|棒|顺滑/) ? "positive"
        : msg.match(/不喜欢|难喝|一般|差/) ? "negative"
        : "neutral",
    }),
  },
  // 4. Profile queries.
  {
    skill: "profile_query",
    keywords: ["我喜欢", "我的偏好", "我的画像", "我喝过什么", "统计一下", "总结一下"],
    params: (msg) => ({ topic: msg }),
  },
  // 5. Follow-up filter — usually on an existing menu ("第3个", "换一款").
  {
    skill: "follow_up_filter",
    keywords: ["第", "第一款", "第二款", "第三款", "换", "改成", "再来", "不苦", "更苦", "更烈", "低度", "高度"],
    params: (msg) => {
      const params: Record<string, unknown> = { free_text: msg };
      const idx = msg.match(/第\s*(\d+|[一二三四五六七八九十])/);
      if (idx) {
        const numMap: Record<string, number> = {
          一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
          六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
        };
        params.index = numMap[idx[1]] ?? Number(idx[1]);
      }
      return params;
    },
  },
  // 6. Label check — needs image; we just route and let the UI handle.
  {
    skill: "label_check",
    keywords: ["酒标", "这瓶", "看看这瓶", "识别一下"],
    params: (msg) => ({ has_image: false, free_text: msg }),
  },
  // 7. Default: recommend by style/ABV. Last so the more specific intents
  //    above always win over a bare "推荐 NEIPA".
  {
    skill: "menu_recommend",
    keywords: [
      "推荐", "挑", "选", "想喝", "帮我选", "帮我挑", "有什么",
      "neipa", "ipa", "stout", "lager", "pilsner", "ale", "sour",
      "拉格", "世涛", "酸啤", "艾尔", "小麦", "精酿",
    ],
    params: (msg) => {
      const params: Record<string, unknown> = {};
      const lower = msg.toLowerCase();
      const styleHit =
        ["neipa", "ipa", "stout", "lager", "pilsner", "sour", "ale"].find((s) =>
          lower.includes(s),
        );
      if (styleHit) params.style = styleHit.toUpperCase();
      const abv = msg.match(/abv\s*(\d+(?:\.\d+)?)/i);
      if (abv) {
        const n = Number(abv[1]);
        params.max_abv = n + 0.5;
        params.min_abv = n - 0.5;
      }
      params.free_text = msg;
      return params;
    },
  },
];

/**
 * Run the keyword table against `message`. Returns the first matching
 * RouteDecision, or null if nothing fires.
 *
 * When `root_ts` is provided, each rule check emits a `rule:eval` stage
 * entry to the trace buffer; a hit also emits `rule:match` so the trace
 * tree shows which rule fired (and the rule_idx of every non-match so
 * the UI can explain why the fast-path missed).
 */
export function keywordRoute(
  message: string,
  onlyEnabled = true,
  root_ts?: number,
  parent_ts?: number | null,
): RouteDecision | null {
  const lower = message.toLowerCase();
  const enabledIds = new Set(
    listSkills()
      .filter((s) => (onlyEnabled ? s.enabled : true))
      .map((s) => s.id),
  );
  const traceEnabled = typeof root_ts === "number";
  const pt = parent_ts ?? root_ts ?? null;
  for (let rule_idx = 0; rule_idx < RULES.length; rule_idx++) {
    const rule = RULES[rule_idx];
    if (!enabledIds.has(rule.skill)) continue;
    const matched = rule.keywords.some((k) => lower.includes(k.toLowerCase()));
    if (traceEnabled) {
      try {
        appendStage(root_ts!, pt, "rule:eval", {
          decision: { rule_idx, skill_id: rule.skill, matched, keyword_count: rule.keywords.length },
        });
      } catch { /* never let tracing kill routing */ }
    }
    if (matched) {
      if (traceEnabled) {
        try {
          appendStage(root_ts!, pt, "rule:match", {
            decision: { rule_idx, skill_id: rule.skill },
          });
        } catch { /* never let tracing kill routing */ }
      }
      return {
        skill_id: rule.skill,
        params: rule.params ? rule.params(message) : { free_text: message },
        reason: `keyword → ${rule.skill}`,
      };
    }
  }
  return null;
}

/** Exposed for tests — number of rules and which skills they cover. */
export const _internal = { RULES };