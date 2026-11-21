import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/Volumes/SanDisk2TB/beer-lens-feishu-harness";
const OUT = path.join(ROOT, "docs/test-results/2026-11-21-menu-coverage/coverage.json");

// Field transcription of the 2026-11-21 El Nido menu image. This is a
// local field replay: no vision model, no network, no queue writes.
const items = [
  { menuIndex: 1, beerName: "本杰明六月啤酒 Benjamin June", brewery: "Living Haus", style: "节日拉格 Festbier", abv: 5.2, price: 85, serving: "425ml" },
  { menuIndex: 2, beerName: "发枝儿 branching out", brewery: "everywhere", style: "现代皮尔森 Modern Pilsner", abv: 5.6, price: 90, serving: "300ml" },
  { menuIndex: 3, beerName: "本原皮尔森 Wills pils", brewery: "Wills", style: "德式皮尔森 German Pilsner", abv: 5.0, price: 75, serving: "300ml" },
  { menuIndex: 4, beerName: "暮色 Polotmavé Pivo", brewery: "Brasserie Du Bas", style: "捷克琥珀拉格 Czech Amber Lager", abv: 5.0, price: 75, serving: "425ml" },
  { menuIndex: 5, beerName: "街区IPA IPA De Quartier", brewery: "Wills", style: "浑浊IPA Hazy IPA", abv: 5.0, price: 85, serving: "300ml" },
  { menuIndex: 6, beerName: "战雾 Haze War", brewery: "Brasserie Du Bas", style: "美式IPA American IPA", abv: 6.0, price: 85, serving: "300ml" },
  { menuIndex: 7, beerName: "崩#0037 Demolition#0037", brewery: "Messorem", style: "浑浊IPA Hazy IPA", abv: 7.0, price: 85, serving: "300ml" },
  { menuIndex: 8, beerName: "膨胀恐惧症 Expansionphobia", brewery: "Totopia", style: "DDH Double West Coast IPA", abv: 8.5, price: 105, serving: "300ml" },
  { menuIndex: 9, beerName: "天鹅狂爱症 Swanphilia", brewery: "Totopia", style: "DDH Double Hazy IPA", abv: 8.5, price: 125, serving: "300ml" },
  { menuIndex: 10, beerName: "星蚀 A Dark in the Light", brewery: "RADIANT", style: "Black IPA", abv: 7.1, price: 70, serving: "300ml" },
  { menuIndex: 11, beerName: "未来学家 Futurist", brewery: "East Gate", style: "Triple Hazy IPA", abv: 10.0, price: 65, serving: "300ml" },
  { menuIndex: 12, beerName: "迷你恐惧症 Tinyphobia", brewery: "Totopia", style: "Dry Hopped Sour IPA", abv: 6.0, price: 115, serving: "300ml" },
  { menuIndex: 13, beerName: "果味满满46号 Just Fruit (Raspberry, Guava)", brewery: "Frequentem", style: "Pastry Sour Ale", abv: 5.0, price: 90, serving: "300ml" },
  { menuIndex: 15, beerName: "无序海上将军 Out of Order Is Rusty Still in the Navy?", brewery: "RaR", style: "Fruited Sour Ale", abv: 5.0, price: 100, serving: "300ml" },
  { menuIndex: 16, beerName: "幽灵草莓大爆炸 Ghost Berry Blast", brewery: "Long Live", style: "Fruited Sour Ale", abv: 6.0, price: 70, serving: "300ml" },
  { menuIndex: 17, beerName: "烈日下的粉碎机 Sunsmasher 2026", brewery: "Holy Goat", style: "Wild Ale", abv: 5.8, price: 90, serving: "300ml" },
  { menuIndex: 18, beerName: "印记 see What sticks", brewery: "everywhere", style: "Imperial Stout", abv: 10.7, price: 145, serving: "300ml" },
  { menuIndex: 19, beerName: "一零六号原型机 Proto 106 Imperial Stout", brewery: "Brewski", style: "Imperial Stout", abv: 11.0, price: 80, serving: "300ml" },
];

process.chdir(ROOT);
const { runLocalMenuKnowledge } = await import(pathToFileURL(path.join(ROOT, "lib/beer-agent/provider.ts")).href);
const result = await runLocalMenuKnowledge(items, { queueKnowledgeGaps: false });
const category = (menuIndex: number) => {
  if ([7, 11].includes(menuIndex)) return "known_unresolved";
  if ([13, 19].includes(menuIndex)) return "version_or_name_gate";
  if ([3, 4, 5, 6, 10, 16].includes(menuIndex)) return "no_record";
  return "confirmed";
};
const rows = result.candidates.map(c => ({
  menuIndex: c.menuIndex,
  displayName: c.displayName,
  brewery: c.brewery,
  category: category(c.menuIndex),
  identity: c.dossier?.identity?.identityStatus ?? null,
  rating: c.dossier?.rating?.value ?? null,
  ratingUrl: c.dossier?.rating?.url ?? null,
  hops: c.dossier?.hops?.value ?? null,
  styleLayer: c.dossier?.styleLayer?.style ?? null,
}));
const summary = {
  candidates: rows.length,
  confirmed: rows.filter(r => r.category === "confirmed").length,
  knownUnresolved: rows.filter(r => r.category === "known_unresolved").length,
  versionOrNameGate: rows.filter(r => r.category === "version_or_name_gate").length,
  noRecord: rows.filter(r => r.category === "no_record").length,
  rated: rows.filter(r => r.rating).length,
  hopRows: rows.filter(r => Array.isArray(r.hops) && r.hops.length > 0).length,
};
await writeFile(OUT, JSON.stringify({
  evidenceLayer: "field transcription of the 2026-11-21 El Nido image; current production runLocalMenuKnowledge; zero model/network; queue writes disabled",
  menuImage: "user-provided 2026-11-21 El Nido menu photo; raw image not stored (contains a Wi-Fi password card)",
  summary,
  rows,
}, null, 2) + "\n");
console.log(JSON.stringify({ summary, rows }, null, 2));
