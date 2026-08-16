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

interface Rule {
  skill: SkillId;
  /** Match if ANY keyword (lowercased substring) appears in the message. */
  keywords: string[];
  /** Params extractor — pulled from the message when the rule fires. */
  params?: (msg: string) => Record<string, unknown>;
}

const RULES: Rule[] = [
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
  {
    skill: "tasting_feedback",
    keywords: ["喝过", "尝了", "感觉", "味道", "口感", "反馈"],
    params: (msg) => ({
      notes: msg,
      sentiment: msg.match(/好喝|不错|喜欢|棒/) ? "positive"
        : msg.match(/不喜欢|难喝|一般|差/) ? "negative"
        : "neutral",
    }),
  },
  {
    skill: "beer_knowledge",
    keywords: ["什么是", "为什么", "区别", "怎么", "如何", "介绍"],
    params: (msg) => ({ question: msg }),
  },
  {
    skill: "memory_correction",
    keywords: ["我其实", "其实不喜欢", "其实喜欢", "更正", "以后不要", "更新一下", "改一下"],
    params: (msg) => ({ correction: msg }),
  },
  {
    skill: "profile_query",
    keywords: ["我喜欢", "我的偏好", "我的画像", "我喝过什么", "统计一下"],
    params: (msg) => ({ topic: msg }),
  },
  {
    skill: "label_check",
    keywords: ["酒标", "这瓶", "看看这瓶", "识别一下"],
    params: (msg) => ({ has_image: false, free_text: msg }),
  },
];

/**
 * Run the keyword table against `message`. Returns the first matching
 * RouteDecision, or null if nothing fires.
 */
export function keywordRoute(message: string, onlyEnabled = true): RouteDecision | null {
  const lower = message.toLowerCase();
  const enabledIds = new Set(
    listSkills()
      .filter((s) => (onlyEnabled ? s.enabled : true))
      .map((s) => s.id),
  );
  for (const rule of RULES) {
    if (!enabledIds.has(rule.skill)) continue;
    if (rule.keywords.some((k) => lower.includes(k.toLowerCase()))) {
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