export type StyleKnowledge = {
  style: string;
  summary: string;
  intensity: number;
};

type StyleSeed = StyleKnowledge & { aliases: string[] };

// Local, stable style education only. These strings never describe a specific
// product's recipe, hops, ingredients, rating or flagship status.
const STYLES: StyleSeed[] = [
  { style: "Dubbel", aliases: ["belgian dubbel"], intensity: 4, summary: "通常以焦糖、深色水果和麦芽甜感为主，酒精感可能比入口印象更明显。" },
  { style: "West Coast IPA", aliases: ["西海岸 ipa", "west coast double ipa", "west coast triple ipa"], intensity: 3, summary: "通常偏干爽，突出柑橘、松脂等酒花气息与较清晰苦感；具体酒花仍以款级来源为准。" },
  { style: "Hazy IPA", aliases: ["new england ipa", "neipa", "hazy ipa (neipa)", "double new england / hazy ipa", "triple new england / hazy ipa", "imperial / double new england / hazy ipa", "imperial oat cream ipa"], intensity: 3, summary: "通常酒体较柔、苦感相对收敛，常见热带水果或柑橘方向；浑浊外观不证明添加了水果。" },
  { style: "IPA", aliases: ["american ipa", "session ipa", "double ipa", "triple ipa", "ddh ipa", "kveik ipa"], intensity: 3, summary: "通常以酒花香气和苦度为主线，但不同分支的干爽度、酒体和酒精强度差异很大。" },
  { style: "West Coast Pilsner", aliases: [], intensity: 2, summary: "通常兼具拉格的干爽脆感与更明显的酒花表达，可能带柑橘或松脂方向；不是本款具体风味断言。" },
  { style: "German Pilsner", aliases: ["german pils", "pilsner", "pils"], intensity: 1, summary: "通常干爽清脆，带谷物、草本或辛香酒花方向，适合作为清爽开场。" },
  { style: "Czech Pilsner", aliases: ["czech lager", "czech pils", "bohemian pilsner"], intensity: 1, summary: "通常有较圆滑的麦芽感与草本酒花气息，苦感常比德式皮尔森更柔和。" },
  { style: "Italian Pilsner", aliases: [], intensity: 1, summary: "通常是干爽拉格基底加更明显的干投酒花香气，具体品种不能由风格推得。" },
  { style: "Best Bitter", aliases: ["english bitter", "ordinary bitter", "esb"], intensity: 2, summary: "常以饼干、吐司或焦糖麦芽平衡英式酒花，名字里的 Bitter 不等于一定比 IPA 更苦。" },
  { style: "Altbier", aliases: ["德式老啤酒"], intensity: 2, summary: "通常有烤面包、坚果或焦糖麦芽方向，收口相对干净，麦芽与苦感较均衡。" },
  { style: "Saison", aliases: ["farmhouse ale"], intensity: 2, summary: "通常偏干爽，可能有胡椒样辛香、果酯或 rustic 发酵气息；不自动代表添加香料。" },
  { style: "Wheat Beer", aliases: ["hefeweizen", "witbier", "belgian wheat"], intensity: 1, summary: "通常酒体较柔、麦感明显；德式小麦常有香蕉或丁香样发酵气息，具体款仍需来源核对。" },
  { style: "Gose", aliases: ["fruited gose"], intensity: 2, summary: "通常为低苦、带乳酸感与轻微咸感的小麦酸啤；水果或香料是否实际添加不能靠风格判断。" },
  { style: "Smoothie Sour", aliases: ["smoothie / pastry sour", "pastry sour", "smoothie sour ale"], intensity: 5, summary: "通常偏浓稠、酸甜和甜点化，果感可能很突出；实际水果、乳糖或其他配料必须有款级证据。" },
  { style: "Fruited Sour", aliases: ["fruited berliner weisse", "berliner weisse", "sour ale"], intensity: 4, summary: "通常以酸感和果味为主线，苦度往往不是重点；具体水果、甜度和原料不能只凭风格推断。" },
  { style: "Lambic", aliases: ["gueuze", "geuze", "wild ale"], intensity: 4, summary: "通常带野性发酵、酸味与复杂陈年气息，具体水果和桶陈信息需要逐款来源。" },
  { style: "Imperial Stout", aliases: ["imperial / double stout", "double stout", "pastry stout", "russian imperial stout"], intensity: 6, summary: "通常酒体厚、烘焙与深色麦芽感强，可能有咖啡、可可或焦糖方向；高酒精款适合靠后慢饮。" },
  { style: "Stout", aliases: ["oatmeal stout", "milk stout", "dry stout"], intensity: 4, summary: "通常有烘焙、咖啡或可可样麦芽方向，但甜度和酒体在不同子风格间差异很大。" },
  { style: "Porter", aliases: ["baltic porter", "robust porter"], intensity: 4, summary: "通常突出深色麦芽、可可或烘烤方向，常比帝国世涛轻，但具体强度以 ABV 和款级资料为准。" },
  { style: "Belgian Tripel", aliases: ["tripel"], intensity: 4, summary: "通常带浅色麦芽、果酯和辛香，酒精度较高但未必以厚重甜感呈现。" },
  { style: "Belgian Pale Ale", aliases: ["belgian single"], intensity: 2, summary: "通常以发酵果酯、辛香和麦芽平衡为主，不应把比利时风格自动等同于高糖感。" },
  { style: "Barleywine", aliases: ["barley wine", "english barleywine", "american barleywine"], intensity: 6, summary: "通常高酒精、麦芽集中，可能带干果、焦糖或明显酒花，适合靠后小杯慢饮。" },
  { style: "Helles", aliases: ["munich helles", "lager", "kellerbier"], intensity: 1, summary: "通常清爽、麦芽柔和、苦度收敛，适合开场；具体产地和酒花不能由拉格风格推出。" },
  { style: "Kölsch", aliases: ["kolsch", "koelsch"], intensity: 1, summary: "通常清爽、干净，麦芽与酒花较柔和，可能有轻微果酯；具体风味仍以款级来源为准。" },
  { style: "Pale Ale", aliases: ["american pale ale", "english pale ale"], intensity: 2, summary: "通常在麦芽与酒花之间取平衡，强度和苦度常低于 IPA，但仍需看具体酒款。" },
];

function key(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
}

const EXACT = new Map<string, StyleSeed>();
for (const seed of STYLES) {
  for (const name of [seed.style, ...seed.aliases]) EXACT.set(key(name), seed);
}

const CONTAINED = [...EXACT.entries()].sort((a, b) => b[0].length - a[0].length);

export function getStyleKnowledge(style: string | null | undefined): StyleKnowledge | null {
  const normalized = key(style ?? "");
  if (!normalized) return null;
  const exact = EXACT.get(normalized);
  if (exact) return { style: exact.style, summary: exact.summary, intensity: exact.intensity };
  const found = CONTAINED.find(([name]) => normalized.includes(name));
  return found ? { style: found[1].style, summary: found[1].summary, intensity: found[1].intensity } : null;
}

export function styleIntensity(style: string | null | undefined): number {
  return getStyleKnowledge(style)?.intensity ?? 3;
}
