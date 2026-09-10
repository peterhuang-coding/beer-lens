const CN_TO_EN_BEER_MAP: Record<string, string[]> = {
  // ── Toppling Goliath ──
  "暴龙苏": ["Pseudo Sue"],
  "双倍干投暴龙苏": ["DDH Pseudo Sue"],
  "赛博暴龙": ["Cyber Sue"],

  // ── Stamm ──
  "年轻领主": ["Young Lordship"],

  // ── Gaffel ──

  // ── RaR ──
  "棱镜之外": ["Out of the Prysm"],

  // ── Duckpond ──
  "奢华冰冻池塘": ["Frozen Pond"],

  // ── Tripping Animals ──
  "罗萨达": ["Limonada Rosada"],

  // ── Suntory ──

  // ── Cloudwater ──
  "查博斯": ["Chubbles"],

  // ── Lolev ──
  "黑豹": ["Panther"],

  // ── Mortalis ──
  "德米海德拉10号": ["DemiHydra"],
  "德米海德拉": ["DemiHydra"],

  // ── Side Project ──
  "蜂巢-第6批次": ["La Ruche"],
  "蜂巢": ["La Ruche"],

  // ── Moonraker ──
  "酷酷": ["Cool Cool"],
  "电光酒花": ["Electric Lettuce"],

  // ── HOMES ──
  "一样一样的": ["SAME SAME SAME"],

  // ── Frequentem ──
  "果味满满34号": ["Just Fruit"],

  // ── Amundsen ──
  "甜甜圈波士顿奶油": ["Donut Series", "DONUT SERIES"],

  // ── 注:风格描述词(浑浊/西海岸/帝国/德式黑啤…)不再映射——
  // 通用风格名命中酒名检索会产生假阳性(如「午餐 西海岸IPA」错配智利 West Coast IPA)。
  // 风格探测走 genericRecommendationQueries,不走本表。(2026-08-25 实测移除)

  // ── Chinese Craft Breweries (高大师) ──
  "婴儿肥": ["Baby IPA"],
  "婴儿肥IPA": ["Baby IPA"],
  "茉莉花茶拉格": ["Jasmine Tea Lager"],
  "烤地瓜艾尔": ["Roasted Sweet Potato Ale"],
  "熊猫王": ["Panda King IPA"],

  // ── Chinese Craft Breweries (京A) ──
  "工人淡色艾尔": ["Workers Pale Ale"],
  "飞拳": ["Flying Fist IPA"],
  "飞拳IPA": ["Flying Fist IPA"],
  "空气大爆表": ["Airpocalypse"],
  "陈皮小麦": ["Mandarin Wheat"],
  "帝都浑浊": ["Beijing Haze"],

  // ── Chinese Craft Breweries (牛啤堂) ──
  "帝都海盐": ["Imperial Sea Salt Gose"],
  "树莓酸小麦": ["Raspberry Sour Wheat"],
  "芒果酸小麦": ["Mango Sour Wheat"],

  // ── Chinese Craft Breweries (18号酒馆) ──
  "跳东湖": ["Jump East Lake IPA"],
  "跳东湖IPA": ["Jump East Lake IPA"],
  "胶片机": ["Film Camera"],
  "不在湖": ["Not Here Lake"],
  "胶片机奶昔": ["Cinema Milk IPA"],

  // ── Chinese Craft Breweries (大跃) ──
  "蜂蜜艾尔": ["Honey Ale"],
  "帝都艾尔": ["Imperial City Ale"],
  "香蕉小麦": ["Banana Wheat"],

  // ── Chinese Craft Breweries (悠航) ──
  "猴拳": ["Monkey Fist IPA"],
  "猴拳IPA": ["Monkey Fist IPA"],
  "京华烟云": ["Hazy Dream"],

  // ── Chinese Craft Breweries (拾捌) ──
  "不接受批评": ["No Criticism"],
  "血滴子": ["Blood Dropper"],

  // ── Chinese Craft Breweries (拳击猫) ──
  "琥珀拉格": ["Amber Lager"],
  "TKO IPA": ["TKO IPA"],
  "荔枝猫": ["Lychee Cat"],

  // ── Chinese Craft Breweries (道酿) ──
  "伏魔": ["Demon Tamer IPA"],
  "伏魔IPA": ["Demon Tamer IPA"],
  "马赛克": ["Mosaic IPA"],
  "春分": ["Spring Equinox"],

  // ── Chinese Craft Breweries (或不凡) ──
  "黄河水": ["Yellow River Water"],
  "君不见": ["Cannot See"],
  "将进酒": ["Will Drink"],

  // ── More Chinese Craft Breweries ──
  "远山": ["Cloudy Mountain"],
  "气泡IPA": ["Bubble Lab IPA"],
  "当歌": ["Song of the Moment"],
  "野鹅IPA": ["Wild Goose IPA"],
  "北平IPA": ["Beijing Machine"],
  "楚门小麦": ["Truman Wheat"],
  "美西西海岸": ["West Coast IPA"],
  "忒斯特IPA": ["Taste Test IPA"],
  "功夫IPA": ["Kung Fu IPA"],
  "红灯笼": ["Red Lantern"],
  "熊猫蜂蜜": ["Panda Honey Ale"],
  "藏式青稞": ["Tibet Barley"],
  "绿城拉格": ["Green City Lager"],

  // ── Chinese Macro Breweries ──
  "青岛黑啤": ["Tsingtao Stout"],
  "青岛IPA": ["Tsingtao IPA"],
  "燕京原浆": ["Yanjing Original"],
  "燕京": ["Yanjing Original"],
  "雪花": ["Snow Beer"],
  "哈尔滨啤酒": ["Harbin Beer"],
  "珠江纯生": ["Pearl River Draft"],
  "乌苏": ["Wusu Beer"],
  "千岛湖": ["West Lake Lager"],

  // ── El Nido 酒单 (2026-08-24 OCR 实测, 2026-08-25 入库验证) ──
  "黑比考黑": ["Sapporo Premium Black Beer"],
  "午餐": ["Lunch"],
};

// These legacy aliases locate a series/base beer, not the printed batch/flavor.
// Keep them for discovery, but never use them as proof for attaching a score.
const DISCOVERY_ONLY_ALIASES = new Set(['德米海德拉10号','蜂巢-第6批次','果味满满34号','甜甜圈波士顿奶油']);

// Only replace a complete known name. Remaining words (including brewery and
// variant qualifiers) stay in the lookup and in the final identity check.
export function resolveChineseAlias(query: string): { name: string; query: string; exact: boolean } | null {
  const trimmed = query.trim().replace(/\s+/g, " ");
  const keys = Object.keys(CN_TO_EN_BEER_MAP).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (trimmed !== key && !trimmed.startsWith(`${key} `)) continue;
    const name = CN_TO_EN_BEER_MAP[key][0];
    if (name) return { name, query: name + trimmed.slice(key.length), exact: !DISCOVERY_ONLY_ALIASES.has(key) };
  }
  return null;
}

export function lookupChineseBeerName(chineseName: string): string | null {
  return resolveChineseAlias(chineseName)?.name ?? null;
}
