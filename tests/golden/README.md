# beer-menu-advisor 中英文菜单黄金集

数据文件：`menu-golden-set.json`。校验测试：`tests/golden-set.test.ts`（随 `npm test` 运行）。

## 定位

按 beer-menu-advisor 收敛设计（Hub feature `F-20260908-012059` §六）建立：
核心指标是「答得准不准」，不是「路由到了哪个 Skill」。当前阶段只交付**数据 + Schema/覆盖率校验**；
端到端执行器在 P0（唯一 `runBeerDecision()`）落地后接入，届时每例直接打真实生产入口。

## 用例覆盖（10 类必覆盖）

| 类 | 含义 | 用例 |
|---|---|---|
| pure-cn-names | 纯中文酒名 | g001 |
| english-names | 英文酒名 | g002 |
| cn-en-paired | 中文译名 + 英文原名成对 | g003 |
| same-name-diff-brewery | 同名不同酒厂 | g004 |
| handwriting-blurry | 手写/低清菜单（图片，fixture 待补） | g005 |
| name-brewery-split-lines | 酒名与酒厂换行 | g006 |
| mixed-price-abv-volume | 价格/容量/ABV 混排 | g007 |
| no-db-hit | 无外部数据库命中 | g008 |
| ocr-errors | 错误 OCR（模糊召回） | g009 |
| constraints | 即时约束（预算/苦度/场景） | g010–g012 |

酒名与酒厂全部取自真实数据源（`lib/beer-agent/beer-db/pipeline.ts` 的 CN_TO_EN_BEER_MAP @ 537f05b），
不虚构「数据库里存在的」酒款；g008 的虚构酒名是刻意构造的无命中场景。

## 字段说明

- `status`：`ready`（文本用例，P0 后可立即执行）| `needs-fixture`（缺真实图片，跳过执行只校验结构）。
- `expected.resolvedItems[].entityConfidence`：期望的实体匹配置信度区间中值（断言用 ±0.15 容差）。
- `expected.constraints`：约束解析后应有的结构化结果（对应设计的 `DecisionConstraints`）。
- `expected.forbiddenPicks` / `allowedPicks`：对 top/safe/explore/caution 四类 pick 的硬性断言。
- `expected.expectedMetrics`：该例对七项核心指标的期望值。

## 七项核心指标

1. `menuItemRecall` — 菜单项目召回率
2. `entityTop1Accuracy` — 实体 Top-1 匹配准确率
3. `constraintSatisfaction` — 约束满足率
4. `topPickExplainability` — 首选可解释率
5. `fabricatedFactRate` — 无依据事实率（无库命中却声称酒款事实即计一次）
6. `lowConfidenceExposure` — 低置信度正确暴露率（该说「可能是」时说了）
7. `e2eLatencyMs` — 端到端延迟

## 断言的硬规则（承接设计 §五）

- 无库命中不得用同名/近似结果冒充（g008）。
- 模糊命中置信度必须低于精确命中，回复带「可能是」（g009）。
- 违反约束的候选只能进 caution（g010、g011）。
- 酒厂行与酒款行必须成对合并（g006）。
- 中英成对出现必须收敛到同一实体（g003）。
