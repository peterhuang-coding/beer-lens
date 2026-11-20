# Beer Lens 接手验收 · 2026-11-20/21

## 结论先行

链路已实际跑通：**飞书真实私聊多轮**（同一 `oc_e2d3…` 私聊、17 款菜单上下文）5 轮全部在 **60 秒内**完成并客户端可见；离线 17 款重放 **2.76 秒**；El Nido 来源型重放 **2.65 秒 / 21 候选 / 16 款有来源 / 7 款有酒花**。`npm run check` 最终 **1122/1122 Node、38/38 Python、typecheck、build 全通过**。

但有两项没有按“全绿”处理：

1. **当前 DeepSeek key 余额为 -3.21 CNY（`available:false`）**，本轮没有新增真实 DeepSeek 图片请求；保留 402 风险证据并停止该路。首轮真人图片证据沿用 11 月 15 日同一私聊的 20.2 秒/17 款结果。
2. **历史 951.603 秒仍无法证明根因**。本轮补上了截止/取消的最小修复与故障注入证据，但 10 月 29 日的系统电源日志已被轮转；只能排除 awake 状态下的可复现代码路径，不能把“系统挂起”写成已证实结论。

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

## 2. 951.603 秒：证据链与边界

历史证据（`test-runs/2026-10-29-deepseek-diagnostic/`）：

- DeepSeek 视觉 transport **30,543ms**，HTTP 200，17 款完整正文。
- controller 从接收至完成 **951,603ms**，即模型返回后仍有约 **921 秒**。
- 当时 harness 只有墙钟，没有单调时钟、分段事件或 heartbeat。

既有 schema2 复验（`docs/test-results/2026-11-14/live-deepseek-schema2.json`，`caffeinate` 下运行）：

- 成功样本：总 **32,004ms**，墙钟与单调时钟差 **1ms**；heartbeat 最大间隔 **1.002s**，无 >5 秒缺口。
- 失败样本：总 **52,012ms**，视觉 51,717ms 在旧 52 秒 agent 截止处被取消；这是 8 秒回复预留的确定性误杀，已改为 4 秒预留/56 秒 agent 预算。

本轮故障注入（`offline-replay-report.json`）：

- 注册一个忽略 signal、永不 settle 的 provider；1.5 秒截止下 **1.503 秒**返回 `turn_deadline_exceeded`，**不写短期记忆**。
- 顶层取消竞态 + 本地知识逐阶段检查 + ref 计时器共同保证：即使某个阶段不合作，调用方也不会超过截止继续等。

判断：**没有找到 awake 状态下可复现的 921 秒代码路径**；历史事件最符合“进程/系统挂起或休眠”解释，但 10 月 29 日电源日志已不在本机保留范围（现存归档从 11 月 6 日开始），因此不能反向证明。生产侧建议继续在 `caffeinate` 下运行 bot；本轮修复保证下一次同类事件会被截止/计时/记忆保护捕获，而不是 15 分钟后返回成功。

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

这是“有来源时逐款知识”的能力证据；**不是新的飞书图片验收**。

## 5. 真实飞书私聊多轮（同一 beer taster 私聊）

问题由 Beer Lens app 发到已授权私聊（真实 Feishu API、真实 handler、真实回发；发送者为 app，不是真人账号），逐轮等回复后再发下一条。首轮真人图片证据见第 6 节。

| # | 问题 | 服务端 firstReply | 客户端 create_time 差 | intent | 菜单 | 结果 |
| --- | --- | ---: | ---: | --- | ---: | --- |
| 1 | 我预算100元以内，想要清爽不苦，选哪款？ | 1,621ms | **850ms** | follow_up_filter | 17→17 | ok |
| 2 | 哪款酒花最香？ | 22,036ms | **21,450ms** | beer_knowledge | 17→17 | ok |
| 3 | 哪款是经典款？ | 7,502ms | **6,980ms** | beer_knowledge | 17→17 | ok |
| 4 | 第7款多少钱？ | 1,021ms | **502ms** | follow_up_filter | 17→17 | ok |
| 5 | 为什么推荐第一款？ | 6,248ms | **5,765ms** | beer_knowledge | 17→17 | ok |

- 5/5 `timing.result=ok`、`replySucceeded=true`、`replyFromFeishuMatchesConversation=true`、60 秒内。
- 菜单快照 17 款全程保留；`#7 Kölsch 55元/425ml，12.94元/100ml` 正确。
- 完整实际回复在 `feishu-multiturn-report.json` 的 `turns[].replyText`。

### 5.1 发现并修复的真实内容缺陷

- **Q1 初版**：`currency:"unknown"` 让预算约束全拒，回复“酒单上没有可以确认符合…”。证据：`feishu-q1-probe-before-fix.json`。
- 币种修复后：能选 3 款，但 top 是 #2 Schwarzbier（深色拉格），且“最稳 #1”又被列入“数据不足谨慎”。证据：`feishu-q1-probe-after-currency-fix.json`。
- 口味/警示修复后离线精确复算（同一真实 17 款菜单 + 同一约束）：top **#1 Your Young Lordship**（¥60/425ml，清爽）、safe **#7 Kölsch**（¥55/425ml，清爽）、explore **#2**；警示名单不再含已入选款。证据：`q1-offline-after-taste-fix.json`。
- **Q5 初版**：回复“您未提供具体偏好”，丢失已说的清爽/预算。修复后在真实私聊做一次定向复验：**24,437ms 客户端**、17 款保留、回复明确引用“不要太苦/清爽/预算不超过100元”。证据：`feishu-q5-recheck.json`。

### 5.2 内容边界

- Q2 酒花：当前 holdout 菜单没有款级酒花来源，回复明确用“风格通性”并说具体酒花未知；**没有编造品种**。来源型酒花证据见 El Nido 重放。
- Q3 经典款：回复前置“来源核对”，说明没有酒厂历史/经典/旗舰/获奖的款级来源，只能按菜单文字“百年老牌”作未核实常识；**没有独立经典款来源**，这是 holdout 的数据边界。
- Q1/Q2/Q5 的价格均来自菜单；没有市场价/产地溢价结论。

## 6. 真实图片首轮（沿用 11 月 15 日真人证据）

`docs/test-results/2026-11-14/feishu-acceptance.md`：

- 真人在同一 beer taster 私聊发送已审查的 `tests/fixtures/tap-list.jpg`（SHA-256 `e9f24bb22950b20bdcc621a3dcd4fdf5c9461da7a94808941ef061bf78649bc6`；无私人边角）。
- 第 3 次尝试成功：**服务端 firstReplyLatency 19,700.8ms**，**客户端 create_time 差 20,200ms**，17 款完整回复，3 个选择，菜单写入 17 款。
- 前两次失败是 `.env.local` DeepSeek key 余额 0（HTTP 402），不是图片内容。
- 本轮复核：当前 `.env.local` DeepSeek key 仍为 **-3.21 CNY / available:false**（`deepseek-balance-check.json`），因此**没有再次发真实图片**，也没有切到其他付费视觉路线。

## 7. 全量回归

最终 `npm run check`（2026-11-21）退出码 0：

- Node：**1122 / 1122** 通过（0 fail / 0 cancelled）。
- Python：**38 / 38** 通过。
- TypeScript typecheck：通过。
- Next.js production build：通过。

新增/更新测试：`tests/controller-deadline.test.mts`、`tests/local-knowledge-deadline.test.mts`、`tests/purchase-decision.test.mts`、`tests/pick-selector.test.ts`、`tests/menu-knowledge-context.test.mts`。

## 8. 验收状态（按用户标准逐项）

| 标准 | 状态 | 证据/边界 |
| --- | --- | --- |
| 清晰菜单行完整覆盖，模糊/裁切项标注 | 通过（历史图） | 17 款；#5 反光/空白、#19/#20 裁切在图像边界注中标出；本轮无新图 |
| 首轮逐款有用知识 | 部分 | 风格级逐款解读；holdout 无款级来源时明确标注“风格通性，非本款事实” |
| 2–3 个符合口味和预算的选择及取舍 | 通过（修复后） | Q1 离线复算 #1/#7/#2；修复前真实 Q1 首选不符，已记录 |
| 酒花/评分/经典款/产地价格有具体来源 | 部分 | El Nido 16 款来源/7 款酒花；holdout 与经典款无独立来源，回复已标注 |
| 多轮预算/怕苦/酒花/经典/价格，保留菜单 | 通过 | 5/5 轮，menu 17→17；Q5 修复后复验引用条件 |
| 含排队至完整回复 ≤60 秒 | 通过（服务侧+客户端代理） | 0.5–24.4s；真人首轮 20.2s；无客户端截图 |
| 保存原问题/回复/成功失败样本 | 通过 | 本目录 JSON |
| `npm run check` | 通过 | 1122 Node / 38 Python / typecheck / build |

## 9. 仍未解决 / 需要用户决定

1. **DeepSeek 余额**：当前 key 不可用（-3.21 CNY）。需要充值或提供另一个已授权的正余额 key；本轮没有擅自切模型/付费视觉。
2. **951 秒根因**：未证明；10 月 29 日电源日志缺失。新截止保护已落地，但“历史那次到底是不是休眠”无法回溯证实。
3. **holdout 款级来源**：这张 17 款菜单没有酒花/评分/经典/产地价来源；El Nido 数据有 16 款来源，但其原图不在本机，不能冒充飞书图片验收。
4. **Q3 经典款**：只有菜单“百年老牌”文字 + 来源边界，没有独立来源；严格按“经典款有具体来源”仍未达标。
5. **飞书多轮发送者**：本轮 5 句由 app 发出；真人首轮图片是 11 月 15 日。若要“真人五轮”证据，需要你在 beer taster 私聊手动发这 5 句（或授权 lark-cli 用户登录）。
6. **客户端可见性**：用 Feishu `create_time` 差 + 消息匹配作为代理，没有截取飞书客户端 UI 截图。

## 10. 证据文件

- `offline-replay-report.json`：17 款离线多轮、名册、取消故障注入。
- `elnido-replay-report.json`：El Nido 来源型重放。
- `feishu-multiturn-report.json`：5 轮真实飞书 API/handler/回发。
- `feishu-q5-recheck.json`：Q5 修复后真实复验。
- `feishu-q1-probe-before-fix.json` / `feishu-q1-probe-after-currency-fix.json`：Q1 失败与中间修复样本。
- `q1-offline-after-taste-fix.json`：Q1 最终离线精确复算。
- `deepseek-balance-check.json`：余额与停止该路请求的证据（无 key）。
- `replay-current.mts`：离线重放脚本。
- 真人首轮：`docs/test-results/2026-11-14/feishu-acceptance.md`、`live-deepseek-schema2.json`。

数据库：`.beer-data/beer.db` SHA-256 保持 `8bd66bec5ef7c80553ef11347fcb48603636006f119f551491f13df4f10bafca`，未提交、未被测试写入。真实会话/短期记忆/凭据保留本地，不提交。
