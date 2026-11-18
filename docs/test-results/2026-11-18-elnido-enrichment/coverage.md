# El Nido 清晰菜单覆盖审计 · 2026-11-19

图片：用户提供的清晰 El Nido 酒头墙照片（21 个编号 + 荔枝冰沙侧卡）。
OCR：DeepSeek Flash，22 项（含 #0 侧卡、#20 山楂气泡水、#21 热红酒）。

## 结论

- **菜单事实**：22 项 OCR/照片转录观察；人工复核前不作为独立审图金标。
- **16/18 啤酒款**有 Untappd 页面（URL + 2026-11-15 核对 + 评分 + 风格/ABV；页面明确写出时补酒花/配料/感官）。
- **2 款仍未知**：#7 Demolition#0037、#10 Futurist（10.5% QDH Triple Hazy；无吻合页面）。
- **非啤酒/非标准项**：#14 TLC 西打、#20 山楂气泡水、#21 热红酒、#0 荔枝啤酒冰沙；菜单事实保留，不作为啤酒推荐。
- 感官字段只在页面有描述时填；部分只是风格/酒花重述，不等于 16 份独立感官档案。
- #5 菜单 5.8 vs 来源 5.9（一位小数）；#6 菜单 8.5 vs 来源 8.0、#12 菜单 5.0 vs 来源 6.0，冲突并列保留。

## 16 款来源

| # | 来源确认 | 评分/人数 | 备注 |
|---|---|---|---|
| 1 | Living Häus Beer Company / Benjamin June | 3.89 / 526 | Festbier；#1 从上一版 Messorem 更新 |
| 2 | Everywhere / branching out | 4.05 / 1,428 | Nectaron/Nelson/Krush；奖项自述；移除无来源“柑橘” |
| 3 | Velka Morava / King Lear | 3.96 / 671 | Best Bitter |
| 4 | Everywhere / Forward Motion | 4.07 / 246 | Mosaic/Citra/Krush |
| 5 | Ebeltoft Gårdbryggeri / Wildflower Cryo Fresh #2 | 3.61 / 22 | Simcoe；ABV 5.8 vs 5.9 |
| 6 | Totopia / Expansionphobia | 3.97 / 122 | ABV 8.5 vs 8.0 冲突 |
| 8 | Batch Craft / Daze | 4.02 / 147 | DDH Hazy DIPA |
| 9 | Totopia / Swanphilia | 4.07 / 409 | Citra, Krush Cryo |
| 11 | Young Master × Mikkeller / Chanpei of My Rye | 3.41 / 70 | 菜单写 Champs of My Rye；ABV 7.5 |
| 12 | Totopia / Tinyphobia | 3.80 / 235 | Sour IPA；Citra/Blackberry/Mango/Cinnamon；ABV 5.0 vs 6.0 |
| 13 | Frequentem / Just Fruit (Raspberry, Guava, Tangerine) | 4.24 / 49 | 菜单写 Just Fruit (Raspberry Guava) |
| 15 | RaR / Out of Order: Is Rusty Still In the Navy? | 3.90 / 242 | 柠檬/青柠果冻、蜂蜜谷物 |
| 16 | Resident Culture / Squirrel Friends | 3.94 / 1,038 | 番石榴/橘子/青柠/椰子 |
| 17 | Holy Goat / Sunsmasher 2026 | 3.99 / 808 | Brett/杏；菜单写 Wild Ale，来源 Sour-Fruited |
| 18 | everywhere / See What Sticks | 4.11 / 238 | 蔓越莓/奶油奶酪/香草/乳糖；上一版 OCR 误作 Stout With Sticks |
| 19 | Brewski / Proto 106 | 3.92 / 330 | 可可/辣椒/香草 |

## 未补齐 / 非啤酒

- #7 Demolition#0037：Untappd 索引无匹配，酒厂小字未确认。
- #10 Futurist：Siren Futurist 是 4.8% Session IPA，不是 10.5% QDH Triple Hazy；不强行匹配。
- #14 TLC 西打、#20 山楂气泡水、#21 热红酒、#0 荔枝啤酒冰沙：非啤酒/非标准项，保留菜单事实。
- 右侧荔枝冰沙侧卡 OCR 编号 #0，不进入啤酒推荐。

## 证据

- `data/menus/elnido-2026-11.json`：16 条；`tests/elnido-2026-11-supplement.test.mts`。
- `elnido-replay-report-2.json`：OCR 22 → 21 保留候选（#20 气泡水排除）→ 16 来源关联；#7/#10 未知。
- `elnido-menu-ocr-2.json`、`untappd-details-2.json`。
- 来源通道：Untappd 公开 Algolia 索引（只读 key）+ 逐款页面；未使用模型常识替代来源。
