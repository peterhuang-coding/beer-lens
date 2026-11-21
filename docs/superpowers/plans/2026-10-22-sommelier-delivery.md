# 2026-10-22 Beer Lens 侍酒知识交付：关键路径审计与分阶段计划

> 事实标注：本文为只读审计与设计稿，不含运行时实现。60s 是目标 SLO、非本次测量；历史约 54s/99s 视觉调用与一次知识调用超时（交接背景摘要）是旧记录、未复测。金标用例是"期望"，不是模型实际输出。

2026-10-24 源码纠正：当前 `untappd-client.ts` 的 `batchSearchBeers` 已委托 `data-layer.ts` 的 Python/SQLite 本地查询。下文旧审计中“LLM结果”的描述不适用于当前入口；`enrichBeers` 实际重复本地查询，并可能通过后台 `verifyAndCache` 访问配置的 Brave。移除此路径不能宣称节省一次模型调用；延迟收益须实际测量。该路径更新包已超时且未采用，来源资料包已独立采用，详见[本轮验证](../../test-results/2026-10-24/menu-additions.md)。

## 1. 现状关键路径审计（代码锚点）

飞书图片一轮的真实链路：

1. `lib/feishu/handler.ts` `enqueueFeishuMessage` → `lib/feishu/queue.ts` `FeishuMessageQueue` 按 chatId 串行 → `processMessageTurn`（handler.ts:32）。
2. `downloadFeishuImage`（handler.ts:76-78）→ `runAgentTurn`（:79）→ 技能 `lib/skills/recommend/execute.ts` `handleImage`（:26）。
3. `execute.ts:35` 调 `lib/beer-agent/provider.ts` `runImagePipeline`（:17）：
   - 以 `skipRecommendation:true` 调 `runMultiStagePipeline`（provider.ts:29-36）。**该开关现有语义**：在 `lib/beer-agent/multi-stage-pipeline.ts:240`、视觉阶段之后且 0 款短路（:223-238）之后提前返回空 recommendation，跳过的是管线自带的 LLM `analyzeRecommendation`（:374-409）；真正推荐由技能层 `recommendFromCandidates` 确定性完成。注意文本路径（:201-210）不检查此开关。
   - 视觉是**单次合并 LLM 调用** `combinedVisionAnalysis`（:319），经 `resolveImageRoute()` + `vision.call`（:332-339）；package 模式 providers 链由调用方给定，不能切到付费方。
   - 视觉提供方 `lib/multimodal/providers/coding-plan.ts`：固定 endpoint 与 `doubao-seed-evolving`、thinking 开启、每次仅一次 fetch、无重试/回退，`timeout=min(请求,180000)`（:116）；429→`VisionRateLimitError`（:60-62），错误不含密钥/报文；已支持外部 `opts.signal` 取消（:85-87,153-162）。
   - **关键路径上阻塞式 `enrichCandidates`（provider.ts:56）实际不贡献首轮字段**：`lib/beer-agent/beer-db/enricher.ts` `enrichBeers` 做一次批量 `batchSearchBeers`（:80），但 LLM 结果 `verified:false`（:142），而 `ocrItemToCandidate` 仅在 `enriched.verified && matchesExactBeerIdentity` 时采用（provider.ts:285-301）——结果被门控丢弃，只增加延迟与超时面。`verifyAndCache` 每次最多验 5 款（:204-235）且为 fire-and-forget。
   - `lookupBeers` 本地批量查（provider.ts:66）；其后对未中分**逐款串行** `await lookupBreweryStats`（:73-89），N 次本地往返。
   - 每次读图都读文件：`readEventCatalog`/`groundMenuCandidates`（:112-118，147 条）与 `readMenuSupplements`/`groundMenuSupplements`（:123-129，17 条），均 fail-soft。
   - `execute.ts` `finish`（:16-24）读长期画像、合并约束；`lib/beer-agent/recommendation/decision.ts` `recommendFromCandidates`（:12-85）纯本地打分/选款/回复，已返回全量 scored（:77-83）。
4. 确定性筛选类追问（不是全部知识问答）：execute.ts:95-100 判定 → `handleFollowUp`（:42-65）只读 `lib/beer-agent/memory/short-term.ts` 文件快照（:64-91），无视觉/LLM/网络。知识类问题仍可进入 `lib/skills/beer-knowledge/execute.ts` 的一次文本模型调用，不能归入零调用结论。快照键为 `sha256([userId, conversationId])`（:59-62）；新菜单仅在 `acceptedNewMenu`（有图/菜单且 candidates>0）时整体替换（:128-146），追问子集不覆盖（:131）。
5. 可观测性缺口：只有 `PipelineEvent` 视觉段 `durationMs`（multi-stage-pipeline.ts:56-64,249-267）；图片下载、本地知识、grounding、决策、STM 落盘、飞书回发无 span；无端到端起止点、无冷/暖/超时分类、无 60s 预算。
6. 失败与事实缺口：视觉整体失败时 execute.ts:37-39 仅回错误、菜单不存留；当前图片路径未传入 hops，`EnrichedBeer.hops` 因而为空；类型仍可接收 input.hops，不能断言所有调用都不填充（enricher.ts:111，applyUntappdResult 未写）；`value-calc.ts` 在 breweryCountry 为空时 `resolveCountry` 默认 US（:54-75）仍输出 `originBenchmark/savingsVsOrigin`（:92-100），属国家常数比价；无"首轮全菜单+后台补知识"两段式交付。

## 2. 可观测时序与状态定义（提案）

- **T_recv** 飞书事件进入 `enqueueFeishuMessage`（长连接/HTTP 入口均适用）；**T_start** 出队开始（队列等待单独计量）；span：`image_download`、`vision`（唯一阻塞 LLM）、`local_knowledge`（本地库+酒厂批查+catalog+supplement）、`decision`、`stm_write`、`feishu_reply`；**T_end** = 完整回复最后一部分的 `replyFeishuMessage` resolve（handler.ts:96）。这是服务侧回发成功代理指标，不证明客户端已展示；真实飞书验收另记录发送到完整回复可见的时间。
- 指标 `first_reply_latency = T_end − T_recv`（包括排队；另报 `T_end − T_start` 的处理耗时）。**目标 SLO：冷首轮 ≤60s（目标，未测量）**。
- 冷/暖：冷=无 STM 且缓存/147/17 无该酒已核验行；暖-A=追问命中 STM（零 LLM/网络）；暖-B=已核验缓存/目录命中。
- timeout=视觉到预算被 signal 取消；partial=视觉成功返回但只识别到部分 items 且 uncertainties 非空；现有非流式图片路径不调用 `parseAndRepairJson` 来抢救超时响应；provider_limit=429/413/401/5xx。
- 菜单不灭：非空快照形成后，后续任何知识失败不得删除/替换它；冷未知显式"待核验"并入队；只回 OCR 名价清单即判失败。

## 3. 分阶段实施（文件级，按优先级）

**P0 计时与预算接口（先只计时，截止行为在 P1 启用）**
1. `multi-stage-pipeline.ts`：`getModelConfig` 配置增 `budgets.firstReplyMs=60000`（目标值，data/pipeline-config.json）；`PipelineEvent` 增上述 span；`combinedVisionAnalysis` 透传 deadline `AbortSignal` 到 `vision.call(..., {signal})`（coding-plan.ts 提供方已支持，但当前 `lib/multimodal/container.ts` 仅传 model/timeoutMs，需同步扩展容器 CallOptions 与 signal 传递，否则取消链不闭合）。
2. `provider.ts`：为 enrich/`lookupBeers`/酒厂循环/两次 grounding 包 span（复用 enrich_start/progress/done，:43,137,169，补 durationMs）。
3. `handler.ts`/`execute.ts`：落一条结构化 timing 记录（仿 short-term.ts `traceMemoryRead/Write` 形态），记录 T_recv/T_start/T_end、冷/暖/结果分类；handler.ts:88 的 failed 仅用于真警告，知识缺口不算失败。
4. 后续实现包必须纳入的依赖（本轮未修改）：`lib/agent/controller.ts`、multimodal 容器 trace 出口。

**P1 首轮关键路径只留 1 次视觉 LLM + 本地知识**
5. `provider.ts:55-60`：移除对 `enrichCandidates` 的 await（其 verified=false 结果本就被 :285 丢弃）；改为 enricher 新增的**已核验缓存批量只读** `batchReadVerifiedCache`（纯本地）；未知名单入队。
6. `enricher.ts`：本阶段新增 `enqueueMenuKnowledge(jobs)`，只持久化去重缺口，不在 turn 首尾隐式 drain 或 fire-and-forget 调模型。补采由单独有界、已授权的 Coding Plan 批次承担；复用 `batchSearchBeers`/`verifyAndCache` 前必须核实模型入口、来源核验方式、用量与失败即停，不能默认旧调用符合套餐限制。暂无新调度器；队列存在不代表已补齐。
7. `provider.ts:73-89`：串行 `lookupBreweryStats` 改一次批量本地查（需在 beer-db/pipeline.ts、data-layer.ts 增批量函数——清单外依赖）；event-grounding/menu-supplements 文件读改进程内 mtime 缓存（清单外依赖）。
8. `multi-stage-pipeline.ts` + `execute.ts`：deadline 到时取消未完成请求；当前 fetch/json 非流式接口无已返回 items，必须记 timeout，不能假设能抢救半个响应。仅当请求成功解析但识别不全时交付 partial，另记完整菜单验收失败。新图失败时保留旧快照但明确其仍是上一张菜单；不得把旧快照套到新图。

**P2 全菜单侍酒知识与表达**
9. 新增本地静态风格库（数据文件+访问器，清单外）：风格→风味通性/常见 ABV 区间/杯型/饮用顺序，输出一律带"风格通性"标签。`decision.ts` 为每字段标 `sourced | ocr | style_inference | unknown`；产品级 hops/旗舰/价格证据只取自已核验结构化字段（`enricher.ts` `EnrichedBeer` 增 hops/flagshipEvidence/价格 provenance，cache.ts 同步——清单外）。
10. 回复层（reply-builder/purchase，清单外）：首轮**逐款覆盖全菜单**（名/厂/风格/ABV/价/容量/知识状态），优先给 2–3 个适配选择及理由，存在真实风险才给 caution，不凑满四个位置；不得截断前 8 款；未知价格≠贵、高分≠旗舰、偏好不合≠差酒。decision.ts 保持全量返回。
11. `value-calc.ts`：国家未核验/为空时不再默认 US 产出 savings；不把国家常数形成的 `originBenchmark` 混入实际原产地比较；若内部保留需明确是未核验估算并排除推荐证据；同款产地比价必须有可比实际价格证据，否则 `savingsVsOrigin=null`（扩展 :80-86 的归零条件）。
12. `short-term.ts`：`lastMenu` 增 `menuComplete/itemCount/knowledgeVersion/queuePending`；partial 照片存 `menuComplete=false`；替换规则维持 :128-132；重置仍走 handler.ts:39-44（删 STM、保留长期画像）。

**P3 记忆安全与验收**
13. 隔离边界：STM 键是 sha256([userId, conversationId])，但当前 `handler.ts:80` 传 userId=chatId，只证明不同聊天隔离，不能证明同群个人画像隔离。首期以私聊验收；群聊支持需在 `lib/feishu/client.ts` 保留 sender identity，再明确共享菜单/个人画像边界后验收；`queue.ts:5-14` 保证同 chat 两张图不交错，第二张 accepted 后原子替换。
14. 数据集：D1 合成菜单 1/8/24/30 款、缺区反光、瓶/罐/杯/环境/非啤酒；D2=现有 147 事件+17 补充（仅试点）；D3=本地 SQLite 冻结快照（实际行数另查，不沿用源码注释的 50k；仅本地暖路径计时，不外发原库）；D4=故障注入 429/413/401/5xx/超时/空内容/截断 JSON。
15. 字段覆盖率按行统计：verified_identity、style、abv、ibu、hops(有来源)、rating+评分人数、price+volume+证据、country、flagship_evidence、freshness_date；另报 unresolved_identity 数；禁止用行数/库容量冒充覆盖。

## 4. 验收金标

`docs/evals/sommelier-gold-v1.json`：20 条合成金标（id/input/expected/forbidden/measurement/layer），覆盖冷/暖/超时/partial/限流、全菜单与风格推理、字段来源门控、产地比价、跨用户记忆安全。均为期望场景，不是实测结果，也尚非可执行测试脚本。

## 5. 交付门槛与执行顺序

先冻结此设计及[知识/SP 契约](../specs/2026-10-22-sommelier-knowledge-design.md)，再依次实施 P0→P1→P2→P3；每包在隔离目录复现失败、补丁、回归，主代理串行采用。预置全菜单知识摘要，首轮不为每款临时联网；知识多轮可用一次受预算约束的套餐文本调用，不重做 OCR。

实施时新增 `tests/sommelier-dossier.test.mts`、`tests/sommelier-latency.test.mts`（本轮尚未创建），与已有 `tests/short-term-memory.test.mts`、`tests/feishu-trial.test.mts` 一起用 `node --import tsx --test <文件>` 验证纯函数/时钟/消息语义，再执行 `npm run check`。不得把故障注入的模拟时钟结果当真实套餐耗时。

20条场景须先落成冻结图片/字段参考答案与断言，其中真实图片、合成图片、纯文字分别统计；原图有私人边角时先本地审查，不外发原图。保留独立留出菜单。真实验收记录每例完整性、事实正确性、偏好理由、排队和回发耗时；报告样本数/成功率/P50/P95，超时和部分输出不能从分母剔除。清晰菜单无漏项且提供实质解读与初始建议、完整回复≤60秒才算目标成功。冷未知仍可用标注的风格知识帮助决策，但款级字段覆盖不足必须独立报告，不能因“待核验”而计成数据齐全。

当前阶段仅设计与验收定义，禁止从本文推断已改服务、已补全数据库或已实测达标。
