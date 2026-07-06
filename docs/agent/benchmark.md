# Beer Benchmark

## Goal

让用户在 5-10 秒内完成反馈，同时产生足够结构化的数据，用于更新个人口味画像。

## Benchmark V1

### Q1. Overall

Prompt:

```text
整体喜欢吗？
```

Options:

- 1: 非常不喜欢
- 2: 不太喜欢
- 3: 一般
- 4: 喜欢
- 5: 非常喜欢

Stored as:

```json
{
  "overall_score": 4
}
```

### Q2. Repeat

Prompt:

```text
下次还会点吗？
```

Options:

- no: 不会
- maybe: 看情况
- yes: 会

Stored as:

```json
{
  "would_drink_again": "yes"
}
```

### Q3. Aroma

Prompt:

```text
香气更像什么？
```

Multi-select options:

- citrus: 柑橘
- tropical: 热带水果
- stone_fruit: 核果
- pine: 松针
- grassy: 草本/青草
- floral: 花香
- bread: 面包/麦芽
- caramel: 焦糖
- coffee: 咖啡/巧克力
- sour_funk: 酸感/野菌
- smoke: 烟熏
- alcohol: 酒精感明显
- unclear: 说不上来

### Q4. Taste And Mouthfeel

Prompt:

```text
入口和收口怎么样？
```

Multi-select options:

- crisp: 清爽
- smooth: 顺滑
- juicy: 多汁
- dry_finish: 收口干
- sweet: 偏甜
- bitter: 偏苦
- sour: 偏酸
- heavy_body: 酒体厚
- thin_body: 偏薄
- sharp: 刺激感强
- balanced: 平衡

### Q5. Context Fit

Prompt:

```text
这杯像你刚才想喝的吗？
```

Options:

- miss: 完全不像
- partial: 有点偏
- match: 基本符合
- perfect: 非常符合

### Q6. Drinking Context

Prompt:

```text
这杯适合什么场景？
```

Multi-select options:

- first_beer: 第一杯
- with_food: 配餐
- slow_sip: 慢慢喝
- explore: 想尝新
- social: 聚会
- dessert: 收尾
- hot_day: 天热
- cold_day: 天冷

### Q7. Free Note

Prompt:

```text
还有什么想记的？
```

Optional free text.

## Compact Chat Input Parser

The agent should also parse natural language:

```text
4.3，会再喝，柑橘热带水果，顺滑，后段有点甜
```

Suggested parsed output:

```json
{
  "overall_score": 4.3,
  "would_drink_again": "yes",
  "aroma_tags": ["citrus", "tropical"],
  "taste_tags": ["smooth", "sweet"],
  "note": "后段有点甜"
}
```

## Profile Update Rules

### Strong Positive Signal

If `overall_score >= 4` and `would_drink_again = yes`:

- Increase weight for style, brewery, hop, aroma tags, and context.
- Add the ABV to comfort range if repeated across entries.

### Weak Positive Signal

If `overall_score >= 3.5`:

- Increase weight slightly.
- Prefer context-specific updates.

### Negative Signal

If `overall_score <= 2.5` or `would_drink_again = no`:

- Increase dislike weights for dominant flavor tags.
- Do not over-penalize the whole style unless repeated.

### Mismatch Signal

If `context_fit = miss` but score is high:

- Mark as good beer, low intent match.

If score is low but context fit is high:

- Mark as a weak beer inside a preferred category.

