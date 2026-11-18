# El Nido 清晰菜单款级来源补齐（2026-11-19）

用户提供第二张更清晰的 El Nido 酒头墙照片。上一版 OCR 把 #1、#5、#11、#12、#13、#17、#18 认错；本版按清晰图重新 OCR，并用正确酒名/酒厂查 Untappd 公开索引。

## 结果

- 图片：21 个编号条目 + 右侧“荔枝啤酒冰沙”侧卡；OCR 22 项（含 #0 侧卡、#20 山楂气泡水、#21 热红酒）。
- **16/18 啤酒款**已有 Untappd 页面（URL + 2026-11-15 核对 + 评分 + 风格/ABV；页面明确写出时补酒花/配料/感官）。
- **2 款仍未知**：#7 Demolition#0037、#10 Futurist（10.5% QDH Triple Hazy；Untappd 没有与酒厂/风格同时吻合的页面）。
- 非啤酒/非标准项：#14 TLC 西打、#20 山楂气泡水、#21 热红酒、#0 荔枝啤酒冰沙；菜单事实保留，但不作为啤酒推荐。
- #6 Expansionphobia 菜单 8.5% vs 来源 8.0%、#12 Tinyphobia 菜单 5.0% vs 来源 6.0%，并列保留冲突；#5 Wildflower 菜单 5.8% vs 来源 5.9%，按一位小数显示处理。

## 16 款来源

| # | 菜单写法 | 来源确认 | 评分/人数 | 关键款级事实 |
|---|---|---|---|---|
| 1 | 本杰明六月啤酒 Benjamin June | Living Häus Beer Company | 3.89 / 526 | Festbier 5.2%；面团/饼干麦芽、柔和草本酒花 |
| 2 | 发枝儿 branching out | Everywhere | 4.05 / 1,428 | Pilsner-Other 5.6%；Nectaron/Nelson/Krush；2024 GABF/WBC 银奖；来源描述不含柑橘/清爽，已移除该推断 |
| 3 | 李尔王 King Lear | Velka Morava | 3.96 / 671 | Best Bitter 4.7%；麦芽甜感、贵族酒花 |
| 4 | 齐飞 Forward Motion | Everywhere | 4.07 / 246 | IPA-American 6.9%；Mosaic/Mosaic Dynaboost/Citra/Krush |
| 5 | 野花 Wildflower Cryo fresh #2 | Ebeltoft Gårdbryggeri | 3.61 / 22 | Hazy IPA；Simcoe；菜单 5.8 vs 来源 5.9 |
| 6 | 膨胀恐惧症 Expansionphobia | Totopia Brewery | 3.97 / 122 | DIPA 8.0%；Mosaic Cryo/Southern Cross；菜单 8.5 冲突 |
| 8 | 微醺幻境 Daze | Batch Craft Beer & Kolaches | 4.02 / 147 | DDH Hazy Double IPA 7.5% |
| 9 | 天鹅狂爱症 Swanphilia | Totopia Brewery | 4.07 / 409 | DDH Hazy DIPA 8.5%；Citra/Krush Cryo |
| 11 | 沉香麦韵 Champs of My Rye | Young Master × Mikkeller | 3.41 / 70 | Rye IPA 7.5%；Chinook/Cryo Simcoe/Cryo Centennial/Cryo Pop/Krush Hyperboost；胡椒黑麦、陈皮、树脂、热带水果、花香 |
| 12 | 迷你恐惧症 Tinyphobia | Totopia Brewery | 3.80 / 235 | Sour IPA；Citra；Blackberry/Mango/Cinnamon；菜单 5.0 vs 来源 6.0 冲突 |
| 13 | 果味满满46号 Just Fruit | Frequentem Brewing Co. | 4.24 / 49 | Sour-Fruited 5.0%；Raspberry/Guava/Tangerine |
| 15 | 无序海上将军 Out of Order… | RaR Brewing | 3.90 / 242 | Sour-Fruited 5.0%；柠檬/青柠果冻、蜂蜜谷物 |
| 16 | 松鼠伙伴 Squirrel Friends | Resident Culture | 3.94 / 1,038 | Sour-Fruited 5.0%；番石榴、橘子、青柠、椰子 |
| 17 | 烈日下的粉碎机 Sunsmasher 2026 | Holy Goat Brewing | 3.99 / 808 | Sour-Fruited 5.8%；Brett、杏；菠萝/核果/柑橘；菜单写 Wild Ale，来源为 Sour-Fruited |
| 18 | 印记 See What Sticks | everywhere | 4.11 / 238 | Imperial Stout 10.7%；蔓越莓、奶油奶酪粉、香草、乳糖 |
| 19 | 一零六号原型机 Proto 106 | Brewski | 3.92 / 330 | Imperial Stout 11.0%；可可、辣椒、香草 |

## 2 款仍未知

- **#7 Demolition#0037**：Untappd 索引没有匹配；酒厂小字未确认。
- **#10 Futurist**：菜单 10.5% QDH Triple Hazy；Untappd 的 Siren Futurist 是 4.8% Session IPA，不是同款；其他 Futurist 也不吻合。
- 不强行匹配，回复标“酒厂/身份未独立核实，仅按菜单文字与风格通性”。

## 验证

- 离线重放：`elnido-replay-report-2.json`：OCR 22 项 → 21 保留候选（#20 气泡水排除）→ 16 款来源关联；#7/#10 未知；非啤酒/非标准项列出。
- 数据：`data/menus/elnido-2026-11.json`（16 条）；`tests/elnido-2026-11-supplement.test.mts`（16 条、酒厂纠正、评分、ABV 冲突、未决评分门控）。
- `npm run check`：1115/1115 Node、38/38 Python、typecheck、build（最终提交再核）。
- 来源通道：Untappd 搜索页公开 Algolia 索引（只读搜索 key）+ 逐款 Untappd 页面；通用 WebSearch 403、mmx 余额不足，未使用模型常识替代来源。

## 边界

- 感官字段只在页面有描述时填；部分为风格/酒花重述，不等于 16 份独立感官档案。
- 页面评分人数/评分是 2026-11-15 快照，不覆盖历史数据库。
- 右侧荔枝冰沙为侧卡，非标准啤酒；不进入啤酒推荐。
- 这张清晰图与上一张图菜单已有变化（#1、#7、#11、#12、#13、#17、#18），旧 13/19 报告只作历史证据，不再代表当前菜单。
