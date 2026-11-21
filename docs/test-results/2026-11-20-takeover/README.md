# Beer Lens 接手验收 · 2026-11-20/21

## 结论先行

链路已实际跑通，并在当前 `1adf895` 之后补了“怕苦/不太苦”解析：

- **新 DeepSeek key 余额 75.00 CNY / available=true**；一次当前代码真实图片诊断：**15.284 秒、17 款、picks #1/#7/#2、1 次请求、0 warnings、heartbeat 最大 1.002 秒、deadline overrun 0**。
- **飞书真实私聊图片首轮**（app 上传/发送同一已审查图，生产 handler 下载+识别+回发）：**服务端 16.447 秒、客户端 16.336 秒、17 款、menu_recommend**；图片下载 636.9ms、agent 15.1s、回发 699ms。
- **同一私聊五轮追问**：客户端 **555 / 526 / 8,980 / 4,749 / 530ms**，全部 ≤60 秒，菜单全程 17 款。Q2“我怕苦”初版复读 Q1；修复后**877ms**复验明确回答 IBU 未知与风格低苦。
- 离线 17 款重放 **2.758 秒**；El Nido 来源型重放 **2.649 秒 / 21 候选 / 16 款有来源 / 7 款有酒花**。
- `npm run check` 最终 **1124/1124 Node、38/38 Python、typecheck、production build 全通过**。

仍不能写成“全部验收通过”：历史 951.603 秒根因未证明；holdout 菜单没有款级来源；Q3 经典款仍只有菜单“百年老牌”文字 + 来源边界；飞书图片与问句由 app 发送（真人首轮图片是 11-15），且没有客户端 UI 截图。

## 1. 本轮代码修复

| 问题 | 最小修复 | 位置 | 回归 |
| --- | --- | --- | --- |
| 截止触发后，controller 仍可能把取消吞成普通 fallback，或在超时后继续写短期记忆 | 整个 turn 与 skill 执行都增加取消竞态；截止错误直接抛出；短期记忆写入前再次检查截止 | `lib/agent/controller.ts` | `tests/controller-deadline.test.mts` |
| 截止计时器 `unref()`，当本轮只剩一个不合作的 pending promise 时事件循环先空掉，截止永远不触发 | 改为 ref 计时器，正常结束仍由 `dispose()` 清理 | `lib/beer-agent/turn-deadline.ts` | 同上；1.5 秒故障注入 1.503 秒拒绝 |
| 视觉返回后，本地库/目录/酒厂/落盘阶段不看取消信号 | `runLocalMenuKnowledge` 逐阶段检查 signal；图片/文本路径透传 signal | `lib/beer-agent/provider.ts`、`lib/skills/recommend/execute.ts` | `tests/local-knowledge-deadline.test.mts` |
| 飞书超时只回“处理出错” | 截止错误回明确的超时提示，不计入 SLO ok | `lib/feishu/handler.ts` | 继承计时回归 |
| OCR `currency:"unknown"` 但证据里有 `¥` 时，预算约束把整单判成“非人民币”而全拒 | 抽出共享币种推断；预算约束使用可见符号证据，真正无符号仍拒绝 | `lib/beer-agent/recommendation/currency.ts`、`constraints.ts`、`purchase.ts` | `tests/purchase-decision.test.mts` |
| 有明确“清爽/不苦”时，纯评分优势让深色拉格压过 Pilsner/Kölsch | 显式口味约束下 topPick 先按 fitScore；无口味约束保持原 combined-score | `pick-selector.ts`、`decision.ts` | `tests/pick-selector.test.ts` |
| “最稳 #1”又被列入“数据不足，谨慎尝试”，自相矛盾 | 警示名单排除已入选款；入选款缺口在各自理由中标出 | `reply-builder.ts` | 同上 |
| 知识追问说“您未提供具体偏好”，丢失当前预算/清爽条件 | 知识提示词注入【当前会话有效条件】，并明确禁止声称未提供偏好 | `lib/skills/beer-knowledge/menu-context.ts` | `tests/menu-knowledge-context.test.mts` |
| “我怕苦/哪款最不苦”没有新增低苦约束，复读上一轮预算答案 | `不太苦/怕苦/最不苦/苦味重/受不了苦` 都解析为 `不苦`；怕苦问法前置“菜单无 IBU、不能保证绝对苦度”的风格说明 | `constraints.ts`、`decision.ts` | `tests/recommendation-constraints.test.mts`、`tests/purchase-decision.test.mts` |

## 2. 951.603 秒：证据链与边界

历史证据（`test-runs/2026-10-29-deepseek-diagnostic/`）：

- DeepSeek 视觉 transport **30,543ms**，HTTP 200，17 款完整正文。
- controller 从接收至完成 **951,603ms**，即模型返回后仍有约 **921 秒**。
- 当时 harness 只有墙钟，没有单调时钟、分段事件或 heartbeat。

既有 schema2 复验（`docs/test-results/2026-11-14/live-deepseek-schema2.json`，`caffeinate` 下）：

- 成功样本：总 **32,004ms**，墙钟与单调时钟差 **1ms**；heartbeat 最大间隔 **1.002s**，无 >5 秒缺口。
- 失败样本：总 **52,012ms**，视觉 51,717ms 在旧 52 秒 agent 截止处被取消；这是 8 秒回复预留的确定性误杀，已改为 4 秒预留/56 秒 agent 预算。

本轮当前代码真实图片（`live-deepseek-2026-11-21-final.json`）：

- 总 **15,284ms**；视觉阶段 12,742ms、本地 enrichment 2,391ms；墙钟与单调差 **0ms**；heartbeat 最大 **1.002s**；`deadlineOverrunMs=0`；17 候选、1 次 DeepSeek 请求、0 warnings。
- 离线故障注入：忽略 signal、永不 settle 的 provider + 1.5s 截止 → **1,503ms** 拒绝，**0 记忆写**。

判断：**没有找到 awake 状态下可复现的 921 秒代码路径**；历史事件最符合“进程/系统挂起或休眠”解释，但 10 月 29 日电源日志已不在本机保留范围（现存归档从 11 月 6 日开始），不能反向证明。新截止竞态 + 本地阶段检查 + ref 计时器保证下一次同类事件会被截止捕获，而不是 15 分钟后返回成功。

## 3. 离线重放（当前生产源码 + 已保存真实正文）

`offline-replay-report.json`，零真实模型/网络请求，临时数据库副本：

| 阶段 | 单调耗时 | 结果 |
| --- | ---: | --- |
| 首轮 controller（替换为捕获的 DeepSeek 正文） | 2,758ms | 17 候选，route=recommend，warnings=[] |
| 预算/不苦追问 | 4ms | 保留 17 款，follow_up_filter |
| 哪款酒花最香 | 115ms | beer-knowledge，名册 17/17 |
| 哪款是经典款 | 111ms | beer-knowledge，名册 17/17 |
| 第7款多少钱 | 3ms | 返回 #7 Kölsch 55元/425ml |
| 为什么推荐第一款 | 111ms | beer-knowledge，名册 17/17 |
| 永不返回 provider + 1.5 秒截止 | 1,503ms | 拒绝，不写记忆 |

检查项全部 true：STM 17 款、17 个名字、每行有价格、vision/enrich 进度事件、知识提示词名册 17 行、取消及时且不写记忆、5 条追问。

## 4. El Nido 来源型重放（真实 OCR 字段，零网络）

`elnido-replay-report.json`：

- 21 个保留候选（22 OCR 项，排除 #20 气泡水）。
- **16 款有 Untappd 来源 + 评分/人数 + 风格/ABV**；**7 款有结构化酒花**（Nectaron/Nelson/Krush、Mosaic/Citra、Simcoe、Southern Cross、Chinook、Citra 等）。
- #7 Demolition#0037、#10 Futurist 身份未决；TLC 西打/热红酒/荔枝冰沙为非啤酒或非标准项。
- 耗时 **2,649ms**，全部检查 true（来源行 ≥16、酒花行 ≥7、未决明确、回复引用来源评分/酒花）。

这是“有来源时逐款知识”的能力证据；**不是新的真人飞书图片验收**。

## 5. 真实飞书私聊：图片首轮 + 五轮追问

图片由 Beer Lens app 上传并发送到已授权私聊；生产 handler 下载、调用真实 DeepSeek、回发。问句也由 app 发送，逐轮等回复后再发下一条。**发送者是 app，不是真人账号**；真人首轮图片证据见第 6 节。

| 轮次 | 输入 | 服务端 firstReply | 客户端 create_time 差 | intent | 菜单 | 结果 |
| --- | --- | ---: | ---: | --- | ---: | --- |
| 图片首轮 | 已审查 `tap-list.jpg` | 16,447ms | **16,336ms** | menu_recommend | 17 | ok |
| Q1 | 预算100元以内、清爽不苦，选哪款？ | 1,103ms | **555ms** | follow_up_filter | 17→17 | ok |
| Q2 初版 | 我怕苦，哪款最不苦？ | 1,083ms | **526ms** | follow_up_filter | 17→17 | **复读 Q1，失败** |
| Q2 复验 | 同上（修复后） | 1,655ms | **877ms** | follow_up_filter | 17→17 | ok，IBU 边界+风格低苦 |
| Q3 | 哪款酒花最香？ | 9,509ms | **8,980ms** | beer_knowledge | 17→17 | ok，风格通性 |
| Q4 | 哪款是经典款？ | 5,289ms | **4,749ms** | beer_knowledge | 17→17 | 有来源边界，但仅菜单文字 |
| Q5 | 第7款多少钱？ | 1,149ms | **530ms** | follow_up_filter | 17→17 | ok，#7 55元/425ml |

- 图片轮：`imageDownloadMs=636.9`、`agentMs=15102.2`、`replyMs=699.1`、`result=ok`。
- 所有轮次客户端 ≤60s，菜单 17→17；Q1/Q2/Q4/Q5 的回复与飞书 API 回读正文一致。
- 图片首轮无文字偏好，picks 为通用 **#8 Chubbles / #1 Pilsner / #3 Cyber Sue**；Q1 预算追问给出 **#1 Your Young Lordship / #7 Kölsch / #2**，符合口味与预算。

### 5.1 发现并修复的真实内容缺陷

- **Q1 初版（第一轮 app 文本验收）**：`currency:"unknown"` 让预算约束全拒，回复“酒单上没有可以确认符合…”。证据：`feishu-q1-probe-before-fix.json`。
- 币种修复后：能选 3 款，但 top 是 #2 Schwarzbier（深色拉格），且“最稳 #1”又被列入“数据不足谨慎”。证据：`feishu-q1-probe-after-currency-fix.json`。
- 口味/警示修复后离线精确复算：top **#1 Your Young Lordship**、safe **#7 Kölsch**、explore **#2**；警示名单不再含已入选款。证据：`q1-offline-after-taste-fix.json`。
- **Q5 初版**：回复“您未提供具体偏好”，丢失已说的清爽/预算。修复后真实复验 24.437s，明确引用“不要太苦/清爽/预算不超过100元”。证据：`feishu-q5-recheck.json`。
- **Q2 初版**：“我怕苦，哪款最不苦？”复读 Q1；原因是“怕苦/最不苦/不太苦”未进入低苦约束。修复后同一私聊 **877ms** 复验，开头明确“当前菜单没有标 IBU，不能保证绝对苦度；Kölsch、Pilsner 等清爽型通常比 IPA 更不苦”。证据：`feishu-q2-recheck.json`。

### 5.2 内容边界

- Q3 酒花：holdout 没有款级酒花来源，回复明确用“风格通性”并说实际品种未知；**没有编造品种**。来源型酒花证据见 El Nido 重放。
- Q4 经典款：回复前置“来源核对”，说明没有酒厂历史/经典/旗舰/获奖的款级来源；随后引用菜单“纯正原产 百年老牌”，并明确“未明确使用经典字样”。**没有独立经典款来源**；跨行归属的经典推断仍是待验缺口。
- 所有价格均来自菜单；没有市场价/产地溢价结论。

## 6. 真实图片首轮

**当前代码（2026-11-21，新 key）**

- `live-deepseek-2026-11-21-final.json`：同一已审查 `tap-list.jpg`（SHA-256 `e9f24bb22950b20bdcc621a3dcd4fdf5c9461da7a94808941ef061bf78649bc6`，无私人边角），临时数据库副本，**1 次 DeepSeek 请求**；15.284s、17 款、picks #1/#7/#2、0 warnings、heartbeat 1.002s、deadline 0 overrun。
- 飞书图片首轮：同一图上传到真实私聊并由生产 handler 处理；服务端 16.447s、客户端 16.336s、17 款、menu_recommend。

**真人首轮（2026-11-15，沿用）**

- 真人在同一 beer taster 私聊发送同一图；第 3 次尝试成功：服务端 19,700.8ms、客户端 20,200ms、17 款完整回复。前两次失败是旧 DeepSeek key 余额 0（HTTP 402）。证据 `docs/test-results/2026-11-14/feishu-acceptance.md`。

## 7. 全量回归

最终 `npm run check`（2026-11-21）退出码 0：

- Node：**1124 / 1124** 通过（0 fail / 0 cancelled）。
- Python：**38 / 38** 通过。
- TypeScript typecheck：通过。
- Next.js production build：通过。

新增/更新测试：`tests/controller-deadline.test.mts`、`tests/local-knowledge-deadline.test.mts`、`tests/purchase-decision.test.mts`、`tests/pick-selector.test.ts`、`tests/menu-knowledge-context.test.mts`、`tests/recommendation-constraints.test.mts`。

## 8. 验收状态（按用户标准逐项）

| 标准 | 状态 | 证据/边界 |
| --- | --- | --- |
| 清晰菜单行完整覆盖，模糊/裁切项标注 | 通过（当前代码） | 17 款；图像边界注标出 #5 不可见/酒厂小字需复核；历史真人图另标 #19/#20 裁切 |
| 首轮逐款有用知识 | 通过（风格级） | 17 款逐款风格通性，明确“非本款事实”；holdout 无款级来源时不编造 |
| 2–3 个符合口味和预算的选择及取舍 | 通过 | 当前诊断 picks #1/#7/#2；Q1 预算追问 #1/#7/#2；图片无偏好时为通用 #8/#1/#3 |
| 酒花/评分/经典款/产地价格有具体来源 | 部分 | El Nido 16 款来源/7 款酒花；holdout 与经典款无独立来源，回复已标注 |
| 多轮预算/怕苦/酒花/经典/价格，保留菜单 | 通过（含 Q2 修复复验） | 5/5 轮 + 图片首轮；menu 17→17；Q2 复验明确 IBU 边界 |
| 含排队至完整回复 ≤60 秒 | 通过（服务侧+客户端时间戳代理） | 图片 16.336s；五轮 0.53–8.98s；真人首轮 20.2s；无 UI 截图 |
| 保存原问题/回复/成功失败样本 | 通过 | 本目录 JSON |
| `npm run check` | 通过 | 1124 Node / 38 Python / typecheck / build |

## 9. 仍未解决 / 需要用户决定

1. **951.603 秒根因未证明**：10 月 29 日电源日志缺失；新截止保护已落地，但“历史那次到底是不是休眠”无法回溯证实。
2. **holdout 款级来源**：这张 17 款菜单没有酒花/评分/经典/产地价的可引用款级来源；El Nido 16 款来源是独立离线证据，不是同图飞书验收。
3. **Q3 经典款跨行归属**：回复仍引用菜单“纯正原产 百年老牌”，并加来源边界；独立父级复核认为“下一 bullet 把产地/传统推成经典属性”的缺口仍在，严格按“经典款有具体来源”未达标。
4. **发送者**：本轮飞书图片与五轮问句由 app 发出；真人首轮图片是 11-15。若要“真人图片+五轮”同一轮证据，需要你在 beer taster 私聊手动发图/发问。
5. **客户端可见性**：用 Feishu `create_time` 差 + API 回读正文作代理，没有截取飞书客户端 UI 截图。
6. 群聊、其他用户、部署、main 合并均未执行。

## 10. 证据文件

- `live-deepseek-2026-11-21-final.json`：当前代码 + 新 key 的真实图片诊断（15.284s/17/picks #1/#7/#2）。
- `live-deepseek-2026-11-21.json`：同一 key 的首个真实图片样本（14.528s；`不太苦` 解析扩展前）。
- `feishu-image-multiturn-report.json`：真实飞书图片首轮 + 五轮（Q2 初版）。
- `feishu-q2-recheck.json`：Q2 修复后真实复验。
- `feishu-q5-recheck.json`：Q5 修复后真实复验。
- `feishu-multiturn-report.json`：早先 app 文本五轮（Q1/Q5 修复前/后边界）。
- `feishu-q1-probe-before-fix.json` / `feishu-q1-probe-after-currency-fix.json`：Q1 失败与中间修复样本。
- `q1-offline-after-taste-fix.json`：Q1 最终离线精确复算。
- `offline-replay-report.json`：17 款离线多轮、名册、取消故障注入。
- `elnido-replay-report.json`：El Nido 来源型重放。
- `deepseek-balance-check.json`（旧 key -3.21）/ `deepseek-balance-check-after-rotation.json`（新 key 75.00）。
- `replay-current.mts`：离线重放脚本。
- 真人首轮：`docs/test-results/2026-11-14/feishu-acceptance.md`、`live-deepseek-schema2.json`。

数据库：`.beer-data/beer.db` SHA-256 保持 `8bd66bec5ef7c80553ef11347fcb48603636006f119f551491f13df4f10bafca`，未提交、未被测试写入。真实会话/短期记忆/凭据保留本地，不提交。
