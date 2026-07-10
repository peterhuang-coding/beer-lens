# Beer Lens

个人啤酒推荐对话系统。拍照酒单 → OCR 识别 → 查真实评分 → 按口味推荐。

## 快速启动

```bash
cd /Volumes/SanDisk2TB/beer_researcher
npm run dev                  # http://localhost:3000
```
Web Chat: `http://localhost:3000`
Debug 面板: `http://localhost:3000/debug`

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

### 已知问题 (待修)

1. **异步 session 更新延迟** — Feishu 要求 <3s 响应，LLM 调用 10-30s，
   当前 fire-and-forget，用户快速追问时记忆可能未写入。
   → 修复方向：先写 processing placeholder，LLM 完成后再更新。

2. **短追问意图不准** — "哪款"、"hello" 可能被误判为 beer_knowledge。
   → 修复方向：活跃菜单时降低 knowledge 优先级。

3. **conversationId 单一** — Web 用 "local-web-session"，Feishu 用 chat_id，无跨渠道同步。

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

- **Pipeline** — 可视化流程图，点节点改参数 (阈值/开关/模型选择)
- **Intent Classifier 节点** — Intent 规则覆盖 (正则 → 意图)
- **Cases** — 每轮对话自动记录，可打标签、写备注、设期望回复

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
