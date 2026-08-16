# LLM 集成技术方案 — Beer Lens Harness

> 状态:草案 v1 · 起草日期 2026-08-16 · 作者:pm-orchestrator

## 1. 目标

给 beer-lens harness 接一个 LLM API,让 8 个 builtin skills 能调用 LLM 生成啤酒推荐 / 知识问答 / 追问对话等回复。**用户提供 API,我接进去,跑通端到端**。

## 2. 现状

- **8 个 builtin skills**:`lib/skills/<category>/execute.ts`(`menu_recommend` / `follow_up_filter` / `tasting_feedback` / `profile_query` / `beer_knowledge` / `label_check` / `memory_correction` / `unclear`)
- **`lib/harness/router.ts`**:支持 skill.enabled = false 跳过(invokeSkill 检查),无 LLM 集成
- **`data/intent-registry.json`**:intent → skill 1:1 映射(已有)
- **`data/raw-data/untappd-csv-input.jsonl`**:32,728 啤酒 records(gitignored, 18M)— 真实数据源
- **`app/harness/page.tsx`**:UI 已有,可观察 skills 启用 / 关闭
- **prod server**:`http://localhost:3000` 跑在 main,stable

## 3. 推荐架构 — LLM-as-Router + Tools

```
┌─────────────────────────────────────────────────────────────────────┐
│                        POST /api/chat (SSE)                         │
└─────────────────────────────┬───────────────────────────────────────┘
                              ↓
                ┌───────────────────────────────────┐
                │  router.ts:Intent Classifier     │  ← LLM Call #1
                │  (LLM-as-router)                  │
                │  ──────────────────────────────   │
                │  input:  user_message            │
                │  output: {skill_id, params}      │
                └─────────────┬─────────────────────┘
                              ↓
                ┌───────────────────────────────────┐
                │  invokeSkill(skill_id, params)    │  ← deterministic
                │  ──────────────────────────────   │     OR
                │  if skill.disabled → skip         │     skill 内 LLM call
                │  if skill → fetch_beers(...)      │     (call #2 可选)
                │  returns: structured result       │
                └─────────────┬─────────────────────┘
                              ↓
                ┌───────────────────────────────────┐
                │  Reply Composer (可选 LLM call)   │  ← LLM Call #2
                │  ──────────────────────────────   │
                │  把 skill 结构化结果包装成         │
                │  自然语言回复                     │
                └─────────────┬─────────────────────┘
                              ↓
                ┌───────────────────────────────────┐
                │  SSE Stream → browser             │
                │  event: delta                    │
                │  event: done                     │
                └───────────────────────────────────┘
```

**为什么这套方案**:
- **LLM 负责"理解意图 + 自然语言生成"** — 强项
- **skill 负责"确定性的啤酒数据查询 / 计算"** — 不消耗 LLM token
- **router 是单一入口** — 用户给什么 API 都接得住,换模型不换业务逻辑

## 4. 目录树(增量)

```
lib/harness/
  llm/                              ← 新增
    provider.ts                     # interface LLMProvider
    openai-compatible.ts            # OpenAI / DeepSeek / Gemini / Ollama 通用
    streaming.ts                    # SSE 适配 + ReadableStream
    prompts/
      system.ts                     # system prompt(啤酒推荐 agent persona)
      intent-classifier.ts          # intent classification prompt
      reply-composer.ts             # reply composition prompt
    tools/
      registry.ts                   # skill → OpenAI tool schema 转换
  router.ts                         # 改:集成 LLM intent classifier
  skill-registry.ts                 # 不改

app/
  api/
    chat/
      route.ts                      # 新增:POST SSE endpoint
  chat/
    page.tsx                        # 新增:对话 UI

tests/
  llm/
    provider.test.mts               # provider 单元(用 mock fetch)
    streaming.test.mts              # SSE 解析
    intent-classifier.test.mts      # 分类正确率(用 fixture message)
    chat-route.test.mts             # 端到端 mock provider
```

## 5. 关键 schema

### `LLMProvider` 接口(`lib/harness/llm/provider.ts`)

```ts
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;              // tool call 时的 function name
  tool_call_id?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON Schema
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatDelta {
  contentDelta?: string;
  toolCallDelta?: { name?: string; argumentsDelta?: string };
  finishReason?: "stop" | "tool_calls" | "length";
}

export interface LLMProvider {
  chat(req: ChatRequest): Promise<ReadableStream<ChatDelta>>;
}
```

### OpenAI-compat adapter(默认走这条路)

`fetch(req).body` → 解析 `data: {choices:[{delta:{...}}]}` SSE 流 → 映射成 `ChatDelta`。

支持 OpenAI / DeepSeek / Moonshot / Gemini OpenAI-compat / Ollama(`/v1/chat/completions`)。

### Tool schema(从 skill manifest 自动生成)

```ts
{
  name: "menu_recommend",
  description: "根据用户口味 / 场合推荐啤酒。从 Untappd 32K 数据集筛选。",
  parameters: {
    type: "object",
    properties: {
      style: { type: "string", description: "风格, 如 'NEIPA' / 'Stout'" },
      max_abv: { type: "number", description: "ABV 上限" },
      country: { type: "string", description: "国家偏好" },
      limit: { type: "integer", default: 5 }
    }
  }
}
```

## 6. 用户需要提供什么

最小配置(放进 `beer-lens/.env.local`):

```bash
# 选 provider (默认 openai-compatible)
LLM_PROVIDER=openai-compatible

# OpenAI-compat 三件套(适用于 OpenAI / DeepSeek / Moonshot / Gemini compat / Ollama)
LLM_API_KEY=sk-xxx
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

# 或选 Anthropic native(需要加 @anthropic-ai/sdk dep)
# LLM_PROVIDER=anthropic
# ANTHROPIC_API_KEY=sk-ant-xxx
# ANTHROPIC_MODEL=claude-sonnet-4-5

# 或选 Ollama 本地
# LLM_PROVIDER=openai-compatible
# LLM_BASE_URL=http://localhost:11434/v1
# LLM_MODEL=llama3.1:8b
# LLM_API_KEY=ollama  # Ollama 不需要 key,占位
```

**用户只要告诉我任一组合,我立刻能接**。

## 7. 范围(scope)

**做** ✅:
1. `LLMProvider` 抽象 + OpenAI-compat adapter
2. System prompt(啤酒推荐 agent persona + 8 个 skill 简介)
3. 8 个 skill → tool schema 转换(基于 manifest.json 自动生成)
4. Router 集成:intent classifier LLM call → invokeSkill → reply composer
5. `POST /api/chat` SSE streaming endpoint
6. `/chat` UI(简洁 message list + input + 流式显示)
7. 错误处理:LLM 4xx/5xx / 网络 / 速率限制 / skill 失败
8. 测试 ≥ 5 case:provider mock / streaming 解析 / intent classifier / disabled skill skip / 端到端 mock

**不做** ❌(明确):
- 多轮对话 history(需要 session storage,放下一轮)
- RAG on 32K Untappd(下一步 scope)
- 用户画像 / memory persistence
- Function calling 嵌套(LLM → tool → LLM → tool)
- 鉴权 / rate limit / 计费
- WebSocket / 实时推送

## 8. 验收标准

- 8 个 skill 都能被 LLM 选中并 invoke
- 啤酒推荐场景:用户说"推荐一款 NEIPA,ABV 6-7%",LLM 返回匹配啤酒
- SSE 流式,首 token < 3s,完整响应 < 15s
- `enabled: false` skill 不被 LLM 调用
- 测试:provider unit / streaming / intent / disabled skip / e2e 全部 pass
- npm test 318 + ≥ 5 new = ≥ 323 / 0 fail
- typecheck 0 error
- curl `POST /api/chat` SSE 实测通过

## 9. 风险 / 不确定

| 风险 | 缓解 |
|---|---|
| 32K 啤酒数据塞不进 prompt | Tool call 模式:LLM 选 skill,skill 内 fetch + filter,只把结果送给 LLM |
| OpenAI-compat 各家 SSE 格式略不同 | adapter 只认 `data: {choices:[{delta:{content}}]}` 通用子集 |
| Anthropic / OpenAI tool call schema 差异 | 第一版只做 OpenAI function calling,Anthropic 留 v2 |
| dev mode Turbopack OOM | 之前已切 prod server (3000),本 feature 在 prod 验证 |
| jsonl 18M 读慢 | 不在本期,RAG 是下一期 |

## 10. 工时预估

- 0.5 天:provider + adapter + streaming
- 0.5 天:router 集成 + tool schema
- 0.5 天:`/api/chat` SSE endpoint + `/chat` UI
- 0.5 天:测试 + typecheck + 验收

合计 **2 天**。需要 user API 配置后才能 e2e 验证。

---

## 下一步

告诉我你的 API 配置(provider / key / model / base_url),我立刻开干。
