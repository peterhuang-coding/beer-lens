# Live QA 修复执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task.

**Goal:** 修复用户已审阅的 docs/test-report-2026-09-11.md 中真实图片、当前约束和会话串数据问题，重跑并发布。

**Architecture:** 保留现有 API、harness 和技能执行器；把约束解析/过滤与候选结果装配集中为可直接测试的纯函数。长期口味按用户保存，活跃酒单按用户和会话保存；视觉 OCR 原始实体作为候选身份，匹配只补充经过校验的事实。

**Tech Stack:** Next.js 16.3.4、TypeScript、node:test、现有 SQLite lookup 与视觉模型。

授权依据：上一轮公开测试报告和修复顺序已交付，用户回复“改吧”。当前范围为缺陷修复；新数据导入与定时采集继续按原设计单独推进。

## Task 1: 会话身份与活跃酒单

Files: app/api/chat/route.ts、lib/beer-agent/memory/short-term.ts、tests/short-term-memory.test.mts。
- [x] 直接调用 updateShortTermMemory/readShortTermMemory，用同一用户两会话、两用户同名会话、长 ID/特殊字符验证隔离，先观察原实现失败。
- [x] Web 使用稳定随机匿名 cookie，去掉固定 anon；短期文件键对完整 userId/conversationId 做哈希。长期画像继续按用户保存。
- [x] 回复过滤不缩减原菜单；新菜单替换，空菜单不复活旧菜单；保存价格、容量、编号、评分来源。
- [x] Run: `npm test`；新增隔离测试通过，旧复制测试换为实际调用，明确去掉被本轮需求取代的跨会话共享断言。

## Task 2: 本轮约束与菜单解析

Files: lib/beer-agent/recommendation/constraints.ts、menu-input.ts、lib/skills/recommend/execute.ts、recommendation/scoring.ts、types.ts、tests/recommendation-constraints.test.mts。
- [x] 用价格 55/85/未知、预算50/80、IPA与拉格、否定风格、后续改预算验证硬过滤和覆盖；先运行新增测试观察失败。
- [x] 数值预算/ABV硬过滤，未知价格不声称在预算内；风格明确时限定风格，不苦作为有解释的风险偏好。
- [x] 从提问部分解析要求，不能把新酒单中的风格当作偏好；含多行酒单或具名新酒项优先走新菜单路径。保留行内价格/ABV/ml和酒厂。
- [x] 三条执行路径共用过滤、评分和结果转换；返回全部菜单但仅从合格候选选择推荐，避免后续预算放宽后丢酒。
- [x] Run: 新增测试 + golden文本字段断言 + `npm run typecheck`。

## Task 3: 图片与实体事实

Files: lib/beer-agent/provider.ts、multi-stage-pipeline.ts、beer-db/pipeline.ts、lib/skills/label-check/execute.ts、tests/vision-candidates.test.mts、tests/lookup-matching.test.mts。
- [x] 保留实际 OCR 酒名/编号/价格/证据，去除同身份重复；不同酒厂同名保留。评分缺失保持未知，不能把酒厂均分当本款评分。
- [x] 对已知中文别名使用实际检索名称校验，保留多词强匹配与酒厂消歧；中文虚构名称、未知后缀不得借通用 IPA 子串命中。
- [x] 用 LA LOVE / Lunch / Dinner 证据核对 OCR 提示，明确英文专名与风格分字段、广告评分仅为图中内容。
- [x] 直接测试候选装配和匹配边界，重新实际发送三张页面原图。

## Task 4: 路由、回复与回归入口

Files: lib/harness/router-rules.ts、router-llm.ts、lib/agent/controller.ts、recommendation/reply-builder.ts、scripts/run-image-benchmark.mjs、tests/llm-rules.test.mts。
- [x] 添加“这瓶是什么酒”携图、泛指图片、“不要太苦的IPA”与知识提问的路由测试，先失败再改。
- [x] 携图识别优先进入视觉技能；/api/agent 对外继续输出既有公开 intent 名称，内部 skill ID 单独保留。
- [x] 编号推荐列表按 candidateId去重；同酒承担多个角色可以解释，但不伪造三款推荐。
- [x] 图片 benchmark 覆盖三张真实 UI 图、fixture，并断言具体酒名/实体与要求；缺图逐项报告，不能用弱 PASS 掩盖。

## Task 5: 验证与交付

- [x] 运行 `npm test`、`npm run typecheck`、`npm run build`，保存退出码与日志。
- [x] 只在3000运行一个实例，重跑原请求、页面点击、预算追问和会话隔离；运行344 API与60 VQA，逐项分析剩余失败，不随意改期望。
- [x] 复核代码改动并解决评审问题；提交 PR/合并到 main并推 GitHub；生产目录构建后恢复3000单实例并检查HTTP。
- [x] 更新公开测试报告与Hub wrapup/方法，区分已修行为、上游错误与缺失样本。
