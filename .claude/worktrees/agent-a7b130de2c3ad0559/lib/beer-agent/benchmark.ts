import type { BenchmarkQuestion, JournalEntry } from "./types";

const aromaMap: Record<string, string> = {
  柑橘: "citrus",
  热带水果: "tropical",
  核果: "stone_fruit",
  松针: "pine",
  草本: "grassy",
  青草: "grassy",
  花香: "floral",
  面包: "bread",
  麦芽: "bread",
  焦糖: "caramel",
  咖啡: "coffee",
  巧克力: "coffee",
  酸: "sour_funk",
  野菌: "sour_funk",
  烟熏: "smoke",
  酒精: "alcohol"
};

const tasteMap: Record<string, string> = {
  清爽: "crisp",
  顺滑: "smooth",
  多汁: "juicy",
  干: "dry_finish",
  甜: "sweet",
  苦: "bitter",
  厚: "heavy_body",
  薄: "thin_body",
  平衡: "balanced"
};

const contextMap: Record<string, string> = {
  第一杯: "first_beer",
  配餐: "with_food",
  慢慢喝: "slow_sip",
  尝新: "explore",
  聚会: "social",
  收尾: "dessert",
  天热: "hot_day",
  天冷: "cold_day"
};

export const benchmarkQuestions: BenchmarkQuestion[] = [
  {
    id: "overall_score",
    prompt: "整体喜欢吗？",
    type: "single",
    options: ["1", "2", "3", "4", "5"].map((value) => ({
      value,
      label: `${value} 分`
    }))
  },
  {
    id: "would_drink_again",
    prompt: "下次还会点吗？",
    type: "single",
    options: [
      { value: "no", label: "不会" },
      { value: "maybe", label: "看情况" },
      { value: "yes", label: "会" }
    ]
  },
  {
    id: "flavor_tags",
    prompt: "味道选几个",
    type: "multi",
    options: ["柑橘", "热带水果", "松针", "花香", "清爽", "顺滑", "偏甜", "偏苦", "偏酸", "咖啡", "焦糖", "酒精感"].map(
      (label) => ({ value: label, label })
    )
  }
];

export function parseBenchmark(rawInput: string): JournalEntry {
  const scoreMatch = rawInput.match(/([1-5](?:\.\d)?)(?:\s*分)?/);
  const wouldDrinkAgain = rawInput.includes("不会")
    ? "no"
    : rawInput.includes("看情况") || rawInput.includes("一般")
      ? "maybe"
      : rawInput.includes("再喝") || rawInput.includes("会")
        ? "yes"
        : undefined;

  return {
    id: `entry_${Date.now()}`,
    createdAt: new Date().toISOString(),
    rawInput,
    parsed: {
      beerName: parseBeerName(rawInput),
      overallScore: scoreMatch ? Number(scoreMatch[1]) : undefined,
      wouldDrinkAgain,
      aromaTags: collectTags(rawInput, aromaMap),
      tasteTags: collectTags(rawInput, tasteMap),
      contextTags: collectTags(rawInput, contextMap),
      note: rawInput
    }
  };
}

function parseBeerName(rawInput: string) {
  const match = rawInput.match(/(?:喝了|记录|beer[:：]?|酒[:：]?)([^，,。]+)/i);
  return match?.[1]?.trim();
}

function collectTags(rawInput: string, map: Record<string, string>) {
  return Object.entries(map)
    .filter(([keyword]) => rawInput.includes(keyword))
    .map(([, tag]) => tag)
    .filter((tag, index, tags) => tags.indexOf(tag) === index);
}

