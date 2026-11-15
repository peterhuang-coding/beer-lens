# Beer Lens 飞书整单识别与多轮验收 · 2026-11-14

本轮在 `codex/feishu-menu-harness` 工作树上接手，目标是打通“飞书发酒单图片 → 整单识别 → 本地知识检索 → 推荐 → 多轮追问”，并定位第二次 DeepSeek 真实返回 17 款却记录 951.603 秒、截止未及时终止的问题。

结论先行：

- 离线重放和一次有界真实 DeepSeek 图片请求均成功：17 款、3 个选择、完整逐款回复、服务侧 32.0 秒（含本地知识与记忆写入，不含飞书发图/排队）。
- 951.603 秒在排除系统休眠的复验中没有复现：墙钟与单调时钟差值 1ms，1 秒 heartbeat 最大间隔 1.002 秒，没有 >5 秒缺口。历史 951 秒更可能是进程/系统挂起，不是可复现的生产代码阻塞；10 月 29 日的电源日志已被系统轮转，无法事后证明。
- 发现并修复了一个真实产品缺陷：预算追问“我预算100元以内…”被文本菜单解析器误当成一条新菜单，覆盖了原 17 款上下文。离线重放已证明修复后 5 条追问全部保留 17 款菜单。
- 发现并修复了知识追问路由：活跃菜单上的“哪款酒花最香 / 哪款是经典款”现在进入 `beer-knowledge` 并携带全量 17 款名册与来源规则，不再被当作筛选推荐。
- 8 秒回复预留会把 agent 预算压到 52 秒，真实 51.7 秒的 HTTP 200 视觉结果被截止取消并丢弃。已改为 4 秒预留（agent 56 秒），定向复验得到 32.0 秒成功结果。
- 飞书私聊真人消息验收见下方“飞书结果”；未完成前不把服务侧代理指标写成客户端已验收。

## 1. 本轮代码修复

| 问题 | 修复 | 回归 |
| --- | --- | --- |
| 预算/约束口语句被 `parseMenuInput` 解析成一条菜单行，覆盖当前菜单 | `lib/beer-agent/recommendation/menu-input.ts`：带问号或“预算/不超过/以内”约束、且没有行号/竖线/拉丁酒名的句子归为 request，不再生成菜单项 | `tests/menu-followup-routing.test.mts` |
| “哪款酒花最香”“哪款是经典款”命中 `哪款` 关键词后被路由到推荐筛选 | 新增 `lib/agent/skill-routing.ts` 纯函数；活跃菜单上的知识词（酒花/经典/评分/产地等）走 `beer-knowledge`，预算/价格/换一款仍走确定性推荐 | 同上 + 离线多轮重放 |
| 回复预留 8 秒导致 agent 截止 52 秒，51.7 秒真实响应被取消 | `lib/beer-agent/turn-deadline.ts` 预留改为 4 秒；agent 预算 56 秒，仍保留会话落盘与飞书回发时间 | 定向真实复验 |
| 首轮只报“共 17 款”，没有标注 #5 反光/空白、#19/#20 被裁切 | `lib/beer-agent/menu-coverage.ts` + `lib/skills/recommend/execute.ts`：把视觉模型返回的 uncertainties 作为“图像边界（不猜测）”放在回复开头 | `tests/menu-followup-routing.test.mts` |
| 旧 Coding Plan 文本 key 已 401；现有 Ark `LLM_*` 对长知识提示超过 60 秒 | 新增 opt-in `BEER_TEXT_PROVIDER=llm`（复用 `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL`，默认行为不变）；Feishu 知识追问改用现有 OpenRouter `deepseek/deepseek-chat`（同题 8–10 秒） | `tests/llm-text-client.test.mts`、`tests/feishu-package-preflight.test.mts`、真实多轮 |

## 2. 951.603 秒的证据链与边界

历史证据（`test-runs/2026-10-29-deepseek-diagnostic/`）：

- 真实 DeepSeek 请求 `totalDurationMs=30543`，HTTP 200，返回 17 款完整正文。
- controller `durationMs=951603`，即模型返回后仍有约 921 秒。
- 当时 harness 只有墙钟，没有单调时钟、分段事件或 heartbeat；10 月 29 日的 `pmset`/统一电源日志已不在本机保留范围（现存 `powermanagement` 归档从 10 月 31 日开始）。

本轮 schema2 诊断（`live-diagnostic-harness.mts`）在 `caffeinate -dimsu` 下执行一次真实 DeepSeek 请求：

- 失败样本：`durationMs=52012`，`monotonicDurationMs=52011`，`wallMinusMonotonicMs=1`；视觉请求 `totalDurationMs=51717`，在 52 秒 agent 截止处被取消（`deadlineOverrunMs=12`），HTTP 状态已 200 但正文未读取完。
- 成功样本：`durationMs=32004`，`monotonicDurationMs=32003`，`wallMinusMonotonicMs=1`；视觉请求 `totalDurationMs=28945`，本地 enrichment `2774ms`；`deadlineOverrunMs=0`。
- 两次 heartbeat：`maxWallGapMs≈1002`、`maxMonotonicGapMs≈1001.8`，`gapsOver5000Ms=[]`。
- 离线故障注入：注册一个忽略 signal、永不 settle 的 provider，1.5 秒截止下 1.507 秒返回取消结果，证明容器/截止竞态本身有效。

判断：没有找到 awake 状态下可复现的 921 秒代码路径；证据支持“进程被系统挂起/休眠”这一解释。该结论仍不能反向证明 10 月 29 日一定发生了休眠，但下一次同类事件会被 schema2 的墙钟/单调时钟/heartbeat 直接捕获。生产侧不再为不可复现的睡眠暂停增加复杂机制；已修复的 52 秒误杀是确定性缺陷。

## 3. 离线重放（当前生产源码 + 已保存真实正文）

`offline-replay-report.json`，零真实模型/网络请求，临时数据库副本：

| 阶段 | 单调耗时 | 结果 |
| --- | ---: | --- |
| 首轮 controller（替换为捕获的 DeepSeek 正文） | 2,933ms | 17 候选，route=recommend，warnings=[] |
| 预算/不苦追问 | 4ms | 保留 17 款，follow_up_filter |
| 哪款酒花最香 | 116ms | beer-knowledge，名册 17/17 |
| 哪款是经典款 | 118ms | beer-knowledge，名册 17/17 |
| 第7款多少钱 | 3ms | 返回 #7 Kölsch 55元/425ml |
| 为什么推荐第一款 | 120ms | beer-knowledge，名册 17/17 |
| 永不返回 provider + 1.5 秒截止 | 1,507ms | 按时取消，无挂起 |

检查项全部为 true：STM 17 款、17 个名字、每行有价格、vision/enrich 进度事件、知识提示词名册 17 行、截止返回、5 条追问。

## 4. 真实 DeepSeek 复验

同一已审查测试图 `tests/fixtures/tap-list.jpg`（SHA-256 `e9f24bb22950b20bdcc621a3dcd4fdf5c9461da7a94808941ef061bf78649bc6`），临时数据库副本，DeepSeek 图片请求 1 次、Coding Plan 文本请求 0 次：

| 项 | 失败样本（8 秒预留） | 成功样本（4 秒预留） |
| --- | ---: | ---: |
| 服务侧总耗时 | 52,012ms | 32,004ms |
| 视觉 transport | 51,717ms（截止取消） | 28,945ms |
| 本地 enrichment | 未到达 | 2,774ms |
| 候选数 | 0 | 17 |
| 首轮回复 | 超时提示 | 3 个选择 + 17 款逐款解读 |
| 记忆/补采队列 | 0 | 17 / 17 |
| 60 秒内服务侧完成 | 是（但内容失败） | 是 |

成功回复的三个选择为 #1 Your Young Lordship（首选）、#7 Kölsch（稳妥备选）、#2 The Premium Malt's Black（探索备选），均带价格、容量、单位价和取舍。完整正文见 `live-deepseek-schema2.json` 的 `turn.reply`。

## 4b. 真实多轮内容验证（非飞书传输）

`real-multiturn-report.json`：首轮仍用已捕获的 17 款正文（0 视觉请求），预算与价格题走本地，酒花/经典/为什么三题走真实文本模型。文本入口先后核查：

- 旧 Coding Plan key：HTTP 401，未继续使用。
- `.env.local` 的 `LLM_*`（Ark `doubao-seed-evolving`）：单题“酒花”在 60 秒仍未返回；不适合 60 秒目标。
- 现有 OpenRouter key + `OPENROUTER_ANALYSIS_MODEL=deepseek/deepseek-chat`：同题 9.5 秒、557 字，引用菜单行号并明确风格通性；三次知识调用约 $0.0016/次。

最终真实多轮（第二次守卫后运行，单调耗时；`real-multiturn-report.json`）：

| 追问 | 路由 | 耗时 | 结果 |
| --- | --- | ---: | --- |
| 预算100元以内、清爽不苦 | 本地 follow_up_filter | 4ms | 保留 17 款，3 个预算内选择 |
| 哪款酒花最香 | beer-knowledge（OpenRouter） | 10,767ms | 列出酒花风格候选；但把预算内 90 元 #4/#6 说成“略超预算” |
| 哪款是经典款 | beer-knowledge（OpenRouter） | 9,708ms | 开头出现“来源核对”，说明菜单无经典/旗舰来源 |
| 第7款多少钱 | 本地 follow_up_filter | 9ms | #7 Kölsch 55元/425ml |
| 为什么推荐第一款 | beer-knowledge（OpenRouter） | 4,809ms | 开头出现“菜单算术核对”：最低单位价是 #7（12.94元/100ml），不是 #1 |

检查项：首轮 17 款、STM 仍 17 款、预算追问保留 17 款、#7 价格正确、全部追问 ≤60 秒。

### 语义审计与确定性守卫

每日独立验收复算了第一轮真实多轮，发现两个不能接受的事实错误：Q5 把 #1 说成“17 款单价最低”（实际 #7 为 12.94元/100ml，低于 #1 的 14.12）；Q3 引入“Gaffel 德国百年老牌酒厂”的无来源背景。新增 `lib/skills/beer-knowledge/evidence-guards.ts`：

- 回复出现“最低/最便宜/性价比最高/最划算”时，前置菜单算术核对，列出实际单位价最低和总价最低的款。
- 回复出现“百年/老牌/创立/旗舰/经典地位/获奖”而菜单没有 sourced reputation 时，前置来源核对 caveat。
- 回复出现“超预算”时，按 `currentConstraints` 的 `maxPrice` 和回复中引用的 `#行号` 核对；90 元在 100 元预算内，不能写成“略超预算”。

第二次真实多轮已证明前两个守卫生效（Q5 4.8 秒、Q3 9.7 秒）；预算守卫由 `tests/knowledge-evidence-guards.test.mts` 用捕获的真实 Q2 反例离线验证。因本轮对同一语义失败点只做一次真实复验，没有追加第三次真实调用；飞书 bot 已加载全部守卫，下一次真人消息会展示最终行为。该证据证明内容链路与预算，不证明飞书客户端可见延迟。

## 5. 飞书结果

见 `feishu-acceptance.md`（由真实私聊收发后填写）。bot 使用现有 Beer Lens app 配置，固定 `BEER_VISION_PROVIDER=deepseek`、`BEER_TEXT_PROVIDER=openrouter`（现有 `OPENROUTER_API_KEY`，`deepseek/deepseek-chat`）、60 秒总预算/4 秒预留；只使用已授权 Beer Lens 私聊与已审查测试图。旧 Coding Plan key 已 401，未用于本轮 Feishu 文本。

## 6. 全量回归

`npm run check` 退出码 0：

- Node：**1100 / 1100** 通过（新增 18 项菜单/路由/覆盖/文本入口/证据守卫回归）。
- Python：**38 / 38** 通过。
- TypeScript typecheck：通过。
- Next.js production build：通过。

完整命令日志在任务临时目录；本目录只保留可复核的源码、报告和真实正文。`.beer-data/beer.db` 未提交、未被测试写入；数据库副本在临时目录并在结束后删除。

## 7. 未达标 / 仍未证明

- 测试图 17 款均为独立留出菜单，未为它们新增款级资料：酒花、评分、经典款、产地价格没有可引用来源，回复明确标注“风格通性，非本款事实”“没有可靠评分不报评分”“无同款市场报价不作溢价结论”。这满足“不虚构”，但不满足“每款都有具体款级来源”；需要另用有已审查来源的菜单验收。
- 2026-10-28 第一次 DeepSeek 返回 0 款且未保存正文，根因仍未知；本轮没有复现该空数组行为。
- 951 秒的历史归因仍缺 10 月 29 日系统电源日志，只能排除 awake 代码路径并等待下一次 schema2 证据。
- 真实 Anthropic 视觉、可比市场报价、旗舰依据库、群聊个人隔离未在本轮执行。
- 飞书客户端可见时间以私聊消息时间戳为准；服务端 `replyFeishuMessage` 成功不等于客户端已渲染。

## 8. 证据文件

- `offline-replay-report.json`：当前源码离线多轮、名册、截止故障注入。
- `live-deepseek-schema2.json`：真实图片请求、单调/墙钟、heartbeat、17 款完整回复。
- `feishu-acceptance.md`：飞书私聊收发、多轮与时间戳（待填）。
- 诊断 harness：`/Volumes/SanDisk2TB/claude-pm-hub/projects/beer-lens/test-runs/2026-10-30-kolsch-telemetry/live-diagnostic-harness.mts`。
