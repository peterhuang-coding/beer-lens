# Beer Lens

个人啤酒推荐对话系统。拍照酒单 → OCR 识别 → 查真实评分 → 按口味推荐。

> **Wave 2b 已完成** (2026-07-26)：merge 5 个分支 + 修复 8 项任务
> - `fix(#4)` STM 异步原子写入 + Feishu ACK placeholder
> - `fix(#5 #6)` 活跃菜单短路 + canonical userId
> - `fix(#7 L1)` analyze_image 走 runImagePipeline
> - `fix(#8)` tasting-feedback AB off 分支恢复 episodic 写入
> - `fix(#9 #10 #11)` crawler 强化 + upsert 连线 + DB 索引
> - `merge dev-vision` 视觉管线打通
> - `merge dev-crawler` Untappd/RateBeer/Flickr/Wikimedia 8 个新 env
> - `merge dev-feedback` feedback 路径稳定性

## 快速启动

```bash
cd /Volumes/SanDisk2TB/beer_researcher
npm run dev                  # http://localhost:3000
```
Web Chat: `http://localhost:3000`
Debug 面板: `http://localhost:3000/debug`

环境变量：复制 `.env.example` → `.env.local`，**至少**需要
`OPENROUTER_API_KEY` 才能跑对话；爬虫/图片相关的 8 个新 var
（`UNTAPPD_PROXY_URL`、`FLICKR_API_KEY`、`WIKIMEDIA_USER_AGENT` 等）
没有也不影响本地 dev，留空即可。

## 系统架构

```
[Web Chat] [Feishu Bot] [CLI]
         \     |     /
      runBeerDialogTurn()    ← 统一入口
              |
    ┌─────────┼─────────┐
    ▼         ▼         ▼
 Intent    Memory    Postprocess
 Classifier Snapshot  Guardrails
    │         │           │
    ▼         ▼           ▼
 Dispatcher  Short-term  Trace+Case
    │        (conversationId)
    ▼
 8 Handler
    │
    ▼
  Reply
```

### 双 Pipeline 现状

Wave 2b 之后存在两条并行的代码路径，目前都是可运行的：

| 路径 | 入口文件 | 角色 | 何时调用 |
|------|---------|------|---------|
| **Active** | `lib/agent/controller.ts` | 生产入口，LLM 自主选 skill | `/api/agent`、`/api/feishu/events` |
| **Legacy** | `lib/beer-agent/orchestrator.ts` | 参考实现，规则优先 + LLM fallback | CLI demo、replay、debug 面板 |

`controller.ts` 通过 `discoverSkills()` 扫描 `lib/skills/` 下 8 个
builtin skill 做动态调度；`orchestrator.ts` 用 `intent-registry.ts`
做规则匹配再走 `dispatcher.ts`。两套都返回兼容的
`BeerDialogResponse`，前端无感。新功能优先加在 active 路径；legacy
路径只在排查 replay / 旧 case 时用到。

## 系统架构

```
[Web Chat] [Feishu Bot] [CLI]
         \     |     /
      runBeerDialogTurn()    ← 统一入口
              |
    ┌─────────┼─────────┐
    ▼         ▼         ▼
 Intent    Memory    Postprocess
 Classifier Snapshot  Guardrails
    │         │           │
    ▼         ▼           ▼
 Dispatcher  Short-term  Trace+Case
    │        (conversationId)
    ▼
 8 Handler
    │
    ▼
  Reply
```

## Session 管理

### 两层记忆

| 类型 | Key | 存储路径 | 内容 |
|------|-----|----------|------|
| 短期记忆 | conversationId | data/memory/short-term/{id}.json | 当前酒单候选、picks、最近20轮对话 |
| 品饮记录 | userId | data/memory/users/{id}/episodes.json | 每次评分记录 |
| 口味画像 | userId | data/memory/users/{id}/profile.json | 聚合：偏好风格、标签、ABV区间 |

### Feishu session 映射

```
Feishu chat_id → conversationId (短期记忆)
               → userId (长期记忆)
Web 默认: conversationId = "local-web-session"
```

Feishu ACK 在 3 秒内返回：先写 STM 原子 placeholder，LLM 完成后再
更新真实结果，由 `lib/beer-agent/memory/short-term.ts` 的
`updateShortTermMemory()` 兜底；handler 异常时通过 `after()` 托管，
避免 placeholder 变成脏数据。

## 啤酒数据库

```
.beer-data/beer.db          SQLite 14,242 款
├── beers                    来自 RateBeer Kaggle (1.58M 评论聚合)
└── untappd_cache            来自 Untappd 缓存 (14 款)
.beer-data/lookup.py         Python 查询脚本, Node 通过 child_process 调用
```

查询优先级: Untappd缓存 → RateBeer SQLite → Web搜索 → "数据暂缺"

## API 路由

| 路由 | 用途 |
|------|------|
| POST /api/agent | Web Chat 入口 |
| POST /api/feishu/events | 飞书事件回调 |
| GET/POST /api/cases | Case 列表/创建 |
| GET/PATCH /api/cases/[id] | Case 详情/更新 |
| GET /api/traces/[traceId] | Trace 查询 |
| GET/PUT /api/debug-config | Pipeline 配置读写 |

## Debug 面板

`http://localhost:3000/debug`

- **Pipeline** — 6 节点水平流 + 8 个内置 skill 侧栏
- **Skills** — 启/禁 skill（写 `data/skills/manifest.json`）
- **Tester** — 文本或 3 张回归图发送请求，实时 SSE 事件 + 解析后 result
- **Recent** — 最近 100 次 chat run,3 秒刷新；点击行展开 entry,再点"查看调用树"看完整 stage 树。键盘导航:`j`/`k` 上下,`Enter` 开树,`e` 展开行,`Esc` 关 modal。Stage 过滤 chips:`全部 / route / rule / llm / skill / memory`
- **Stats** — RPM / p50 / p95 / error rate / skill & LLM 分布 / rule hits
- **Rules** — starter + YAML 已加载规则表 + 启/禁开关 + 「⟳ Reload YAML」按钮（热加载 `data/rules/*.yaml`）

### `/debug` Stage 2 写入

- **调用树** (`/api/debug/trace/[root_ts]`) — 按 `root_ts + parent_ts` 把所有 hook 点 stage 拼成缩进树,色块区分 stage。树根 chat → route → skill → 内部事件
- **JSONL 保存** (`POST /api/debug/trace/[root_ts]/save`) — 把 buffer 里某次完整 trace 写到 `data/traces/{root_ts}.jsonl`,每行一条 JSON entry,FIFO 淘汰后仍能离线回放
- **stage filter** (`/api/debug/recent?stage=skill,llm`) — 按 stage 前缀过滤 entry;Recent tab 顶部 chips 切换

### Hard rule engine

`lib/harness/rules.ts` 定义 7 个 starter rule,覆盖 6 个 stage:

| stage | starter rule | action |
|---|---|---|
| pre-route | `yaml-block-offtopic` / `routing-freshness-pre-override` | `block` / `route_override` |
| post-route | `yaml-flag-ipa-mention` / `low-confidence-route-warn` | `annotate` / `log` |
| pre-skill | `cross-skill-freshness-block` | `block` |
| post-skill | `polish-short-reply` | `transform_reply` |
| pre-llm | `retry-llm-unclear-lean-menu` | `retry_llm_with_hint` |
| post-llm | `image-ocr-freshness` | `annotate` |
| post-memory-read | `memory-style-bias-annotate` | `annotate` |

支持的 action 类型:`route_override` / `filter_candidates` / `annotate` / `block` / `log` / `transform_reply` / `retry_llm_with_hint`。每次触发写一条 `rule:fire` stage,Stats tab 据此统计。

### YAML rules (热加载)

`data/rules/*.yaml` 自动加载到规则引擎。schema:

```yaml
rules:
  - id: my-rule
    stage: post-skill            # pre-route / post-route / pre-skill / post-skill / pre-llm / post-llm / pre-memory-read / post-memory-read / pre-memory-write / post-memory-write
    enabled: true                # default true
    priority: 50                 # 越高越先
    description: 一句话说明
    when:                        # 可选;AND 拼接
      - field: profile.preferredStyles.0.weight
        op: ">"
        value: 0.6
    then:
      kind: annotate             # block | log | annotate | route_override | transform_reply
      key: profile.bias_style
      value_from: profile.preferredStyles.0.style
      reason: "yaml rule demo"
```

支持的 op:`exists` / `missing` / `==` / `!=` / `contains` / `starts_with` / `ends_with` / `matches` (RegExp) / `>` / `>=` / `<` / `<=`。

修完 YAML 不用重启:点 `/debug` Rules tab 的「⟳ Reload YAML」按钮即可。代码级 rule 改动 (`lib/harness/rules.ts`) 需进程重启。

## Image pipeline 硬化

- **客户端压缩** (`lib/image/compress.ts`) — Canvas 缩放 + JPEG 重编码。`>2MB` 或 `>1600px` 触发,质量从 0.85 递减到 0.50
- **服务端 guard** — `POST /api/chat` 拒绝 `>8MB` dataUrl,返回 413
- **vision timeout** — `multi-stage-pipeline.ts` 默认 vision `timeoutMs: 45000` (从 30000 提升)
- **fallback chain** — vision 默认 `gemini-2.5-flash → gpt-4o-mini → claude-sonnet-4`。每个失败自动试下一个;可在 `process.env.VISION_FALLBACK_MODELS="m1,m2,m3"` 覆盖

## Case 标签 (在飞书里直接发)

```
bad: intent_wrong
标记: hallucination
ocr_wrong 备注xxx
good
```

发完后自动标记上一轮对话。去 Debug → Cases 查看。

可用标签:
- good — 没问题
- intent_wrong — 意图错误
- ocr_wrong — OCR 错误
- recommendation_bad — 推荐不好
- hallucination — 幻觉/编造
- memory_wrong — 记忆错误
- data_missing — 数据缺失
- response_bad — 回复不好

## 环境变量 (.env.local)

```
OPENROUTER_API_KEY=sk-or-v1-xxx
OPENROUTER_VISION_MODEL=google/gemini-2.5-flash
OPENROUTER_ANALYSIS_MODEL=openai/gpt-4o-mini
OPENROUTER_SITE_URL=http://localhost:3000
OPENROUTER_APP_TITLE=Beer Lens
OPENROUTER_PROXY=http://127.0.0.1:7890    # 代理(可选)
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_VERIFICATION_TOKEN=xxx
```

爬虫/图片源新增 8 个 var（详见 `.env.example` 顶部注释段）：
`UNTAPPD_PROXY_URL`、`UNTAPPD_USER_AGENT`、`UNTAPPD_COOKIE`、
`UNTAPPD_TIMEOUT_MS`、`RATEBEER_SOURCE_URL`、`RATEBEER_SOURCE_FILE`、
`FLICKR_API_KEY`、`WIKIMEDIA_USER_AGENT`。本地 dev 不填也不报错。

## Skills 系统

Wave 2b 之后，`lib/agent/controller.ts` 通过 `discoverSkills()` 扫描
`lib/skills/` 下 8 个 builtin skill，由 LLM 按用户输入选 skill。
完整清单见 `data/skill-manifest.json`；规则/样例/slot 见
`data/intent-registry.json`。

| Skill id (文件) | 中文名 | 对应 intent | 触发场景 | 是否需要图片 |
|-----------------|--------|------------|----------|--------------|
| `recommend` | 啤酒推荐 | `menu_recommend` | 拍照酒单、"帮我推荐 IPA" | 否（可带图） |
| `menu-vision` | 酒单视觉分析 | (内部 helper) | recommend 内部：OCR + 酒单分类 | 是 |
| `taste-feedback` | 品饮反馈 | `tasting_feedback` | "4 分，会再喝，热带水果" | 否 |
| `profile-query` | 口味画像查询 | `profile_query` | "我的口味是什么" | 否 |
| `beer-knowledge` | 啤酒知识 | `beer_knowledge` | "IPA 和拉格有什么区别" | 否 |
| `label-check` | 酒标检查 | `label_check` | 拍照单瓶/单罐 | 是 |
| `memory-correction` | 记忆纠正 | `memory_correction` | "记错了，应该是 Green City" | 否 |
| `fallback` | 兜底处理 | `unclear` | "hello"/无法识别意图 | 否 |

注：`follow_up_filter` 在 active 路径里被 `recommend` 内部短路
（"有 IPA 吗"/"第 3 个怎么样"直接走 `lastMenu` 过滤，不调 LLM），
因此不占独立的 skill 槽位。

## 飞书接入

```bash
# 公网隧道
cloudflared tunnel --url http://localhost:3000
# 或
unset http_proxy https_proxy && ngrok http 3000
```

飞书后台 → 事件订阅 → URL: `https://xxx.trycloudflare.com/api/feishu/events`
订阅事件: `im.message.receive_v1`
Encrypt Key: 留空
权限: `im:message` `im:resource` `im:message:send_as_bot`

## 核心文件索引

```
lib/beer-agent/
├── orchestrator.ts           ★ 主入口 runBeerDialogTurn()
├── dialog-types.ts           请求/响应/Trace/Case 类型
├── intent-classifier.ts      意图识别 (规则优先 + LLM fallback)
├── dispatcher.ts             意图 → Handler 分发
├── trace.ts                  Trace 写盘
├── cases.ts                  Case 管理
├── replay.ts                 Replay prompt 生成
├── provider.ts               Vision pipeline (主链路)
├── handlers/
│   ├── menu-recommend.ts     酒单推荐 (图片→vision model→beer DB→推荐引擎)
│   ├── follow-up-filter.ts   追问过滤 (只在菜单候选里筛)
│   ├── tasting-feedback.ts   品饮反馈 (解析→写episodic→重建画像)
│   ├── profile-query.ts      画像查询
│   ├── beer-knowledge.ts     知识问答 (纯LLM)
│   ├── label-check.ts        酒标检查
│   ├── memory-correction.ts  记忆纠正 (占位)
│   └── unclear.ts            意图不明追问
├── memory/
│   ├── short-term.ts         短期记忆 (per conversationId)
│   ├── episodic.ts           品饮记录 (per userId)
│   └── profile.ts            口味画像聚合
├── recommendation/
│   ├── scoring.ts            worthScore + fitScore
│   ├── pick-selector.ts      top/safe/explore/avoid
│   └── reply-builder.ts      中文推荐语
├── postprocess/
│   └── guardrails.ts         后置规则
└── beer-db/
    ├── data-layer.ts         TS ↔ Python 数据桥
    └── enricher.ts           啤酒信息补全
```

## 多轮对话流程

```
User: [发酒单照片]
  → intent: menu_recommend
  → vision pipeline (Gemini Flash OCR + 提取)
  → beer DB 查评分
  → 推荐引擎打分
  → 回复 + 写入 short-term memory (lastMenu)

User: "有 IPA 吗"
  → intent: follow_up_filter
  → 读 short-term memory → lastMenu candidates
  → 过滤 IPA 风格
  → 只在菜单里推荐

User: "4.5 分, 会再喝, 热带水果"
  → intent: tasting_feedback
  → 匹配 short-term memory 中 activeBeer
  → 写 episodic memory
  → 重建 taste profile
```
