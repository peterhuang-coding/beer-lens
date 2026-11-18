# El Nido 菜单款级来源覆盖审计 · 2026-11-15

图片：用户提供的 El Nido 酒头墙照片（本地审查，未外发原图）。
OCR：DeepSeek Flash，20 项；右侧「荔枝啤酒冰沙」侧卡未被 OCR 纳入。

## 结论

- **菜单事实**：20/20 项为 OCR/照片转录观察（酒名/酒厂文字/风格/ABV/价格/容量）；人工复核前不作为独立审图金标。
- **款级公开事实**：**13/19 保留候选（18 啤酒 + 1 西打）**已有 Untappd 页面（URL + 核对日期 + 评分 + 风格/ABV；有来源的补酒花/配料/感官）。感官字段只在页面有描述时填，部分只是风格/酒花重述，不等于 13 份独立感官档案。
- **6 款**没有找到可引用的公开页面，保持“酒厂/身份未独立核实，仅菜单文字 + 风格通性”，不编造。
- **2 项非啤酒**（#14 西打、#20 山楂气泡水）：菜单事实保留，但不作为啤酒推荐；#20 不进入逐款啤酒行。
- 剩余 6 款：Futurist（#11）、Trypophobia（#12）、Fruit Punch #46（#13）、TLC 西打（#14）、TLC 琥珀（#17）、Stout With Sticks（#18）。

## 已补齐 13 款（来源均为 Untappd 页面，checked_at 2026-11-15）

| # | 菜单写法 | 来源确认 | 评分/人数 | 酒花/配料/感官 | 备注 |
|---|---|---|---|---|---|
| 1 | 往昔时光 稻米拉格 | Messorem / Il Fut Un Temps: Rice Lager | 4.03 / 303 | 风格 Rice Lager | 菜单酒厂“Microbrasserie”被来源纠正为 Messorem |
| 2 | 发枝儿 现代皮尔森 | Everywhere / branching out | 4.05 / 1,428 | Nectaron, Nelson, Krush；2024 GABF/WBC 银奖；来源描述不含柑橘/清爽，已移除该推断 | 酒厂 OCR 正确 |
| 3 | 李尔王英式苦啤 | Velka Morava / King Lear | 3.96 / 671 | 麦芽甜感、贵族酒花 | 复用 2026-10 数据并新增 Untappd 评分；OCR “Great Morava”已作为别名 |
| 4 | 齐飞 西海岸IPA | Everywhere / forward motion | 4.07 / 246 | Mosaic, Mosaic Dynaboost, Citra, Krush | |
| 5 | 野花 冷萃鲜酿2号 | Ebeltoft Gårdbryggeri / Wildflower Cryo Fresh #2 Simcoe | 3.61 / 22 | Simcoe | **菜单 7.5% vs 来源 5.9%，冲突并列**；OCR “Ebbzart”正确应为 Ebeltoft |
| 6 | 膨胀恐惧症 | Totopia Brewery / Expansionphobia | 3.97 / 122 | Mosaic Cryo, Southern Cross 等 | OCR “Toftebo”应为 Totopia |
| 7 | 沉浸浸酿 浑浊IPA | Outer Range / In the Steep | 4.09 / 37,286 | Citra；葡萄柚/橘子/杏 | OCR “Other Half”错误，已纠正 |
| 8 | 微醺幻境 | Batch Craft Beer & Kolaches / Daze | 4.02 / 147 | DDH Hazy Double IPA | |
| 9 | 天鹅狂想症 | Totopia Brewery / Swanphilia | 4.07 / 409 | Citra, Krush Cryo | OCR “Toftebo”应为 Totopia |
| 10 | 沉香美韵 黑麦IPA | Young Master × Mikkeller / Chanpei of My Rye | 3.41 / 70 | Chinook, Cryo Simcoe, Cryo Centennial, Cryo Pop, Krush Hyperboost | **菜单 6.7% vs 来源 7.5%，冲突并列**；菜单英文 “Chappel Of My Eye”为别写 |
| 15 | 无序海上将军 | RaR Brewing / Out of Order: Is Rusty Still In the Navy? | 3.90 / 242 | 柠檬/青柠果冻、蜂蜜谷物 | OCR “Everywhere”错误 |
| 16 | 松鼠伙伴 | Resident Culture / Squirrel Friends | 3.94 / 1,038 | 番石榴、橘子、青柠、椰子 | OCR “Wilding”错误 |
| 19 | 一零六号原型机 | Brewski / Proto 106 | 3.92 / 330 | 可可豆、辣椒、香草 | OCR “Everywhere”错误 |

数据文件：`data/menus/elnido-2026-11.json`（12 条新条目）+ 现有 `elnido-2026-10.json` 的 King Lear（新增评分/别名）。`sourced_facts` 只使用页面明确列出的酒花/配料/感官；评分单独带 URL 与日期。

## 未补齐 6 款（保持未知）

| # | 菜单写法 | 为什么没有补 |
|---|---|---|
| 11 | 未来学家 四倍干投三倍浑浊IPA 10.0% | Untappd 索引没有匹配（Siren Futurist 是 4.8% Session IPA，不是同款） |
| 12 | 迷你恐惧症 干投酸IPA 5.5% | Totopia 的 Tropophobia 是 6.7% Hazy IPA；Trapphobia 是 5.5% Hazy Pale Ale；均与菜单风格不符，不能强行匹配 |
| 13 | 果味满满46号 甜点酸艾尔 | Untappd 索引没有 “Fruit Punch #46” 匹配 |
| 14 | 温柔呵护 苹果荔枝硬果酒西打 | Human Robot 啤酒页无 TLC；可能是苹果酒/非啤酒条目 |
| 17 | 拉克雷斯 英式琥珀艾尔 | Wunderkammer 啤酒页无 TLC；名称歧义 |
| 18 | 印记 帝国世涛 | Untappd 索引没有 “Stout With Sticks” 匹配 |

这些行在 bot 回复中显示“酒厂/身份未独立核实，仅按菜单文字与风格通性”，不冒充已核实事实。

## 非啤酒

- #20 山楂气泡水（0.0%，400ml，¥40）在回复开头单独标注“未纳入逐款啤酒解读与推荐”。
- 右侧「荔枝啤酒冰沙」侧卡 OCR 未纳入，后续如需完整覆盖应补 OCR。

## 验证

- 离线重放：20 项 OCR → 19 款啤酒 → 13 款带来源/评分/酒花；6 款未知；山楂气泡水排除。`elnido-replay-report.json`。
- 测试：`tests/elnido-2026-11-supplement.test.mts`（12 条来源、酒厂纠正、评分、ABV 冲突）；`tests/menu-followup-routing.test.mts`（非啤酒项）。
- 全量 `npm run check` 结果见本轮最终提交。

## 数据来源通道

- Untappd 公开站点搜索页暴露的 Algolia 搜索索引（只读、公开搜索 key）用于找款；逐款直接抓取 Untappd 页面。
- 通用 WebSearch 仍 403（Volcano Ark 未激活），mmx 余额不足；因此未补齐的 6 款没有可引用来源，不能编造。
