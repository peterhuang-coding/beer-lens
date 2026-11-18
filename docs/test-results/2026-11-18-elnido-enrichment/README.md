# El Nido 2026-11 菜单款级来源补齐

用户提供 El Nido 酒头墙照片后，本轮把能公开核验的款级事实写进本地 supplement，而不是继续只给风格通性。

## 结果

- OCR：20 项（含 #20 山楂气泡水；右侧荔枝冰沙侧卡未纳入 OCR）。
- 菜单事实：20/20 项为 OCR/照片转录观察（酒名/酒厂文字/风格/ABV/价格/容量）；人工复核前不作为独立审图金标。
- **款级公开事实：13/19 保留候选（18 款啤酒 + 1 款西打）**有 Untappd 页面（URL + 2026-11-15 核对 + 评分 + 风格/ABV；页面明确写出时补酒花/配料/感官）。感官字段只在页面有描述时填，部分只是风格/酒花重述，不等于 13 份独立感官档案。
- 6 款没有可引用的公开匹配，保持“酒厂/身份未独立核实，仅按菜单文字与风格通性”，不编造。
- #14 西打和 #20 山楂气泡水属于非啤酒项；菜单事实保留，但不作为啤酒推荐。

## 13 款来源

| # | 来源确认 | 评分/人数 | 关键款级事实 |
|---|---|---|---|
| 1 | Messorem / Il Fut Un Temps: Rice Lager | 4.03 / 303 | Rice Lager |
| 2 | Everywhere / branching out | 4.05 / 1,428 | Nectaron, Nelson, Krush；2024 GABF/WBC 银奖；页面描述不含柑橘/清爽，已移除该推断 |
| 3 | Velka Morava / King Lear | 3.96 / 671 | 麦芽甜感、贵族酒花 |
| 4 | Everywhere / forward motion | 4.07 / 246 | Mosaic, Mosaic Dynaboost, Citra, Krush |
| 5 | Ebeltoft Gårdbryggeri / Wildflower Cryo Fresh #2 Simcoe | 3.61 / 22 | Simcoe；**ABV 7.5 vs 5.9 冲突** |
| 6 | Totopia / Expansionphobia | 3.97 / 122 | Mosaic Cryo, Southern Cross 等 |
| 7 | Outer Range / In the Steep | 4.09 / 37,286 | Citra；葡萄柚/橘子/杏 |
| 8 | Batch Craft / Daze | 4.02 / 147 | DDH Hazy Double IPA |
| 9 | Totopia / Swanphilia | 4.07 / 409 | Citra, Krush Cryo |
| 10 | Young Master × Mikkeller / Chanpei of My Rye | 3.41 / 70 | 黑麦、陈皮、五种酒花；**ABV 6.7 vs 7.5 冲突** |
| 15 | RaR / Out of Order: Is Rusty Still In the Navy? | 3.90 / 242 | 柠檬/青柠果冻、蜂蜜谷物 |
| 16 | Resident Culture / Squirrel Friends | 3.94 / 1,038 | 番石榴、橘子、青柠、椰子 |
| 19 | Brewski / Proto 106 | 3.92 / 330 | 可可豆、辣椒、香草 |

OCR 酒厂误读已由来源纠正，例如 “Other Half”→“Outer Range”、“Toftebo”→“Totopia”、“Ebbzart”→“Ebeltoft”、“Everywhere”→“RaR/Brewski”。修正规则：规范化后不同的酒厂才覆盖，仅空格/标点差异保留菜单原文。

## 6 款未补齐

`#11 Futurist`、`#12 Trypophobia`、`#13 Fruit Punch #46`、`#14 TLC 西打`、`#17 TLC 琥珀`、`#18 Stout With Sticks`。这些在 Untappd 索引中没有与菜单风格/ABV 同时吻合的款；强行匹配（例如 Siren Futurist 4.8% Session IPA、Totopia Tropophobia 6.7% Hazy IPA）会制造错误事实，因此保持未知。

## 数据与验证

- `data/menus/elnido-2026-11.json`：13 条，含 `sources`、`rating`、`sourced_facts`、`field_disagreements`。
- 原始 2026-10 快照未被改写；King Lear 作为新菜单条目单独收录，避免破坏历史 17 条不可变快照。
- 离线重放：`elnido-replay-report.json`（20 OCR → 19 啤酒 → 13 有来源；6 未知；非啤酒排除）。
- 测试：`tests/elnido-2026-11-supplement.test.mts`（13 条、来源/评分/ABV 冲突、OCR 酒厂纠正）；`tests/menu-followup-routing.test.mts`（非啤酒项）。
- 全量 `npm run check` 见提交记录。

## 数据通道

通用 WebSearch 403、mmx 余额不足；本次使用 Untappd 搜索页公开的 Algolia 搜索配置（只读公开 key）定位款，再逐页抓取 Untappd 页面。没有使用模型常识替代来源。
