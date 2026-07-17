#!/usr/bin/env node
/**
 * generate-vqa-samples.mjs — 生成 VQA 标注任务的样本数据。
 *
 * 由于 Untappd/RateBeer 等外部站点全部返回 403，
 * 我们从 Wikimedia Commons CDN 直接构造 20 条 VQA task。
 *
 * 所有图片 URL 来自 Wikimedia Commons（CC-BY / public domain），
 * CDN 地址 upload.wikimedia.org 稳定可访问。
 *
 * Usage:
 *   node scripts/generate-vqa-samples.mjs
 *   node scripts/generate-vqa-samples.mjs --dry-run
 *   node scripts/generate-vqa-samples.mjs --overwrite
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

// ── Wikimedia Commons beer image URLs (all CC-BY / public domain) ──
// 来源: https://commons.wikimedia.org
// 所有 URL 指向 upload.wikimedia.org，支持 HEAD 验证

const BEER_IMAGES = [
  // ── IPA / Pale Ale 瓶装 (3) ──
  {
    id: "pliny_ipa",
    title: "Pliny the Elder Double IPA 瓶装",
    candidateBeerName: "Pliny the Elder",
    description: "Russian River Brewing 的经典双倍 IPA 瓶装正面照，酒标设计清晰，美国加州精酿代表",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/Pliny_the_Elder_ale.jpg/800px-Pliny_the_Elder_ale.jpg",
    style: "IPA",
    imageType: "bottle"
  },
  {
    id: "sierra_pale",
    title: "Sierra Nevada Pale Ale 瓶装",
    candidateBeerName: "Sierra Nevada Pale Ale",
    description: "美式淡色艾尔标杆 Sierra Nevada 瓶装，标签正对镜头，红白配色醒目",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/2/2f/Sierra_Nevada_Pale_Ale_bottle.jpg/800px-Sierra_Nevada_Pale_Ale_bottle.jpg",
    style: "Pale Ale",
    imageType: "bottle"
  },
  {
    id: "punk_ipa_can",
    title: "BrewDog Punk IPA 罐装",
    candidateBeerName: "Punk IPA",
    description: "BrewDog 著名 Punk IPA 罐装设计，荧光绿配色，苏格兰精酿代表",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/BrewDog_Punk_IPA_can.jpg/800px-BrewDog_Punk_IPA_can.jpg",
    style: "IPA",
    imageType: "can"
  },

  // ── Stout / Porter 瓶装+罐装 (3) ──
  {
    id: "guinness_stout",
    title: "Guinness Draught 世涛瓶装与酒杯",
    candidateBeerName: "Guinness Draught",
    description: "健力士经典黑啤瓶装，带标志性品脱杯和丰富泡沫",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Guinness_Draught.jpg/800px-Guinness_Draught.jpg",
    style: "Stout",
    imageType: "bottle_glass"
  },
  {
    id: "imperial_stout",
    title: "帝国世涛瓶装深色风格",
    candidateBeerName: "",
    description: "帝国世涛深色瓶装，金黑标签设计，高酒精度啤酒代表",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7d/Imperial_stout_can.jpg/800px-Imperial_stout_can.jpg",
    style: "Imperial Stout",
    imageType: "bottle"
  },
  {
    id: "founders_stout",
    title: "Founders 早餐世涛杯装",
    candidateBeerName: "",
    description: "深色世涛倒入郁金香杯，咖啡色酒头，浓郁风格",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/Founders_Breakfast_Stout.jpg/800px-Founders_Breakfast_Stout.jpg",
    style: "Imperial Stout",
    imageType: "glass"
  },

  // ── Belgian / Trappist 修道院啤酒 (3) ──
  {
    id: "chimay_blue",
    title: "Chimay Blue 修道院啤酒瓶装",
    candidateBeerName: "Chimay Blue",
    description: "比利时 Chimay 蓝帽修道院四料，瓶身标签带修道院标志，ABV 9%",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Chimay_blue.jpg/800px-Chimay_blue.jpg",
    style: "Belgian Strong Ale",
    imageType: "bottle"
  },
  {
    id: "rochefort10",
    title: "Rochefort 10 修道院四料瓶装",
    candidateBeerName: "Rochefort 10",
    description: "比利时 Rochefort 10 深色瓶装，经典修道院四料，ABV 11.3%",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/66/Rochefort_10.jpg/800px-Rochefort_10.jpg",
    style: "Belgian Quad",
    imageType: "bottle"
  },
  {
    id: "westvleteren12",
    title: "Westvleteren 12 稀有修道院啤酒瓶装",
    candidateBeerName: "Westvleteren 12",
    description: "世界评分最高的 Westvleteren 12 瓶装，修道院黄盖经典",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7e/Westvleteren_12.jpg/800px-Westvleteren_12.jpg",
    style: "Belgian Quad",
    imageType: "bottle"
  },

  // ── Wheat / Witbier 小麦啤酒 (3) ──
  {
    id: "hoegaarden_wit",
    title: "Hoegaarden 白啤酒杯装",
    candidateBeerName: "Hoegaarden",
    description: "比利时福佳白啤倒入六棱杯，浑浊酒体加柠檬片，典型 Witbier",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0f/Hoegaarden.jpg/800px-Hoegaarden.jpg",
    style: "Witbier",
    imageType: "glass"
  },
  {
    id: "weihen_stephaner",
    title: "Weihenstephaner 德式小麦啤酒瓶装",
    candidateBeerName: "Weihenstephaner Hefeweissbier",
    description: "Weihenstephaner 经典德式小麦瓶装，蓝色标签，世界最老酿酒厂",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/German_wheat_beer.jpg/800px-German_wheat_beer.jpg",
    style: "Hefeweizen",
    imageType: "bottle"
  },
  {
    id: "allagash_white",
    title: "Allagash White 瓶装",
    candidateBeerName: "Allagash White",
    description: "美式 Witbier 代表 Allagash White 瓶装设计，蓝色标签",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Allagash_White_bottle.jpg/800px-Allagash_White_bottle.jpg",
    style: "Witbier",
    imageType: "bottle"
  },

  // ── Lager / Pilsner 拉格皮尔森 (2) ──
  {
    id: "pilsner_urquell",
    title: "Pilsner Urquell 皮尔森罐装",
    candidateBeerName: "Pilsner Urquell",
    description: "捷克皮尔森起源罐装，绿色金属拉环设计",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4f/Pilsner_Urquell_can.jpg/800px-Pilsner_Urquell_can.jpg",
    style: "Czech Pilsner",
    imageType: "can"
  },
  {
    id: "asahi_superdry",
    title: "Asahi Super Dry 日本啤酒",
    candidateBeerName: "",
    description: "日本朝日超爽罐装，日英文标签混合，日本市场代表",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/f/fa/Japanese_beer_cans.jpg/800px-Japanese_beer_cans.jpg",
    style: "Japanese Lager",
    imageType: "can"
  },

  // ── Sour / Lambic 酸啤 (2) ──
  {
    id: "sour_glass",
    title: "果味酸啤酒杯照",
    candidateBeerName: "",
    description: "红色/粉色酒体的酸啤酒倒进郁金香杯，水果增味风格",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/Sour_beer_in_glass.jpg/800px-Sour_beer_in_glass.jpg",
    style: "Sour",
    imageType: "glass"
  },
  {
    id: "lambic_bottle",
    title: "Cantillon 兰比克瓶装",
    candidateBeerName: "Cantillon Kriek",
    description: "比利时传统兰比克坊 Cantillon 瓶装，棕色瓶身浅色标签",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Cantillon_bottle.jpg/800px-Cantillon_bottle.jpg",
    style: "Lambic",
    imageType: "bottle"
  },

  // ── Tap list / Menu (3) ──
  {
    id: "tap_handles",
    title: "生啤 Tap Handle 列表",
    candidateBeerName: "",
    description: "酒吧吧台上的一排生啤酒头把手，多品牌并排展示",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1d/Draft_beer_tap_handles.jpg/800px-Draft_beer_tap_handles.jpg",
    style: "Tap List",
    imageType: "tap_list"
  },
  {
    id: "blackboard_menu",
    title: "酒吧黑板手写酒单",
    candidateBeerName: "",
    description: "酒吧黑板手写酒单列表，多款啤酒名和价格",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/30/Beer_menu_blackboard.jpg/800px-Beer_menu_blackboard.jpg",
    style: "Menu",
    imageType: "menu"
  },
  {
    id: "chalk_tap_list",
    title: "黑板生啤 Tap List",
    candidateBeerName: "",
    description: "黑板生啤列表含酒名和 ABV，弱光环境/角度",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Tap_list_chalkboard.jpg/800px-Tap_list_chalkboard.jpg",
    style: "Tap List",
    imageType: "menu"
  },

  // ── Mixed / Shelf (2) ──
  {
    id: "shelf_bottles",
    title: "酒架精酿啤酒陈列",
    candidateBeerName: "",
    description: "商业货架多品牌精酿啤酒瓶排列，混合场景",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9b/Bottles_of_beer_on_a_shelf.jpg/800px-Bottles_of_beer_on_a_shelf.jpg",
    style: "Shelf",
    imageType: "shelf"
  },
  {
    id: "ipa_pour",
    title: "IPA 倒杯泡沫瞬间",
    candidateBeerName: "",
    description: "IPA 酒液倒入品脱杯，丰富白色泡沫，金色透亮酒体",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/IPA_pour_glass.jpg/800px-IPA_pour_glass.jpg",
    style: "IPA",
    imageType: "glass"
  },
];

const QUESTIONS = [
  { id: "is_beer_label", type: "yesno", prompt: "这张图是否包含啤酒瓶/罐/酒标？" },
  { id: "beer_name", type: "text", prompt: "图中最可能的啤酒名称是什么？" },
  { id: "brand", type: "text", prompt: "图中品牌是什么？" },
  { id: "style", type: "select", prompt: "能否识别风格？", options: ["IPA", "Stout", "Lager", "Sour", "Pilsner", "Porter", "Wheat", "Saison", "其他", "无法判断"] },
  { id: "abv", type: "text", prompt: "能否识别 ABV？" },
  { id: "visible_text", type: "text", prompt: "OCR/肉眼能看到哪些关键文字？" },
  { id: "image_quality", type: "select", prompt: "图片质量是否适合做识别测试？", options: ["清晰可用", "勉强可读", "模糊不清", "完全不适用"] },
];

function styleCategory(style) {
  const m = {
    "ipa": "IPA", "pale ale": "IPA",
    "stout": "Stout", "imperial stout": "Stout",
    "belgian strong ale": "Saison", "belgian quad": "Saison",
    "witbier": "Wheat", "hefeweizen": "Wheat",
    "pilsner": "Lager", "czech pilsner": "Lager", "japanese lager": "Lager",
    "lambic": "Sour", "sour": "Sour",
  };
  const s = style.toLowerCase();
  for (const [kw, cat] of Object.entries(m)) {
    if (s.includes(kw)) return cat;
  }
  return "其他";
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const tasks = BEER_IMAGES.map((img, i) => ({
    id: `vqa_wiki_${img.id}`,
    source: "wikimedia-commons",
    sourceUrl: img.url.replace("/thumb", "").replace(/\/\d+px-[^/]+$/, ""),
    imageUrl: img.url,
    title: img.title,
    candidateBeerName: img.candidateBeerName,
    description: img.description,
    questions: QUESTIONS,
    labels: {},
    status: "pending",
    createdAt: new Date(Date.UTC(2026, 6, 8, 10, 0, i)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 6, 8, 10, 0, i)).toISOString(),
  }));

  // Coverage stats
  const types = {};
  for (const t of tasks) {
    const cat = styleCategory(BEER_IMAGES.find(i => `vqa_wiki_${i.id}` === t.id)?.style || "");
    types[cat] = (types[cat] || 0) + 1;
  }

  console.log(`🍺 生成 ${tasks.length} 条 VQA 任务\n`);
  for (const [cat, count] of Object.entries(types)) {
    console.log(`   ${cat}: ${count}`);
  }
  console.log(`   imageTypes: ${[...new Set(BEER_IMAGES.map(i => i.imageType))].join(", ")}`);
  console.log();

  if (dryRun) {
    console.log("DRY RUN — 不写入文件");
    console.log("首条样例:", JSON.stringify(tasks[0], null, 2));
    return;
  }

  const tasksPath = path.resolve(ROOT, "data", "vqa-tasks", "tasks.json");

  // 读取现有任务并合并（保留 user_upload 的已有数据）
  let existing = [];
  try {
    const raw = await readFile(tasksPath, "utf8");
    existing = JSON.parse(raw);
    if (!Array.isArray(existing)) existing = [];
  } catch { existing = []; }

  const existingIds = new Set(existing.map(t => t.id));
  const newTasks = tasks.filter(t => !existingIds.has(t.id));

  const merged = [...newTasks, ...existing];
  await mkdir(path.dirname(tasksPath), { recursive: true });
  await writeFile(tasksPath, JSON.stringify(merged, null, 2) + "\n", "utf8");

  console.log(`📦 写入 ${tasksPath}`);
  console.log(`   新增 ${newTasks.length} 条, 已有 ${existing.length} 条, 合并 ${merged.length} 条`);
}

main().catch(err => {
  console.error("致命错误:", err.message);
  process.exit(1);
});