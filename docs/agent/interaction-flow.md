# Beer Agent Interaction Flow

## Product Promise

站在酒单前，直接告诉用户今晚该喝哪杯；喝完以后，用很轻的反馈让系统越来越懂他。

## Core Pain Points

1. 用户看了酒单不知道该喝哪个。
2. 用户尝了一口，也很难把“好不好喝”和“为什么适合/不适合自己”表达出来。

## Primary Loop

### 1. User Sends Context

User can send any combination of:

- Menu photo
- Tap list screenshot
- Beer label photo
- Beer names or numbers
- Location or venue name
- Mood or constraint, such as `想喝清爽的`, `不要太苦`, `预算 80 以内`, `今天想尝新`

### 2. Agent Extracts Candidates

The agent extracts likely beer candidates:

- Beer name
- Brewery
- Style
- ABV
- IBU if available
- Serving format
- Price
- Source text
- Confidence

If confidence is low, the agent asks a narrow follow-up:

```text
我不确定第 4 个是 The Alchemist 还是 Alchemist Brewing。你拍近一点或告诉我第 4 行原文就行。
```

### 3. Agent Enriches Candidates

Candidate enrichment should be source-aware:

- User profile: private ratings, flavor tags, style preferences
- Structured beer data: style, ABV, known brewery, public rating if allowed
- Venue data: current availability, venue type, distance, price level
- Web/social text: venue site, recent menu posts, public mentions
- Freshness hints: especially for IPA, hoppy pale ale, lager, and draft beer

Every enriched fact should carry:

- `source`
- `confidence`
- `updated_at` when available

### 4. Agent Ranks Beers

Rank by two main scores:

- `worth_score`: whether this is objectively worth drinking tonight
- `fit_score`: whether this user is likely to enjoy it

The top recommendation is not always the highest public rating. The agent should prefer fit when the user's intent is clear.

### 5. Agent Replies In Human Language

The answer should be concise, decisive, and explainable:

```text
今晚先点 3 号 Green City。

它最贴你：热带水果、低苦度、7% 左右，和你之前给高分的 Hazy IPA 很像。

保守一点选 2 号 Pivo Pils，清爽干净，第一杯很稳。
6 号 Oude Geuze 是好酒，但酸和野菌感明显，不一定适合你今晚。
```

### 6. User Drinks And Benchmarks

After drinking, the agent sends a lightweight benchmark prompt. The user can answer by tapping choices or typing naturally.

Example typed answer:

```text
4.3，会再喝，热带水果，顺滑，后段有点甜，第一杯很合适
```

### 7. Agent Updates Profile

The agent updates:

- Style preference
- Hop preference
- Aroma and flavor likes/dislikes
- ABV comfort range
- Bitterness, sweetness, acidity, body tolerance
- Context fit, such as first beer, food pairing, novelty seeking

## Recommendation Modes

### Safe Pick

Best for:

- First beer
- User is tired
- User wants reliable
- User gave a strong constraint

Output should minimize risk.

### Explore Pick

Best for:

- User says `想尝新`
- Rare bottle appears
- Strong public reputation but uncertain fit

Output should explain the risk.

### Avoid Pick

Useful when a beer is high quality but poor fit:

```text
这是好酒，但不建议你今晚点。你之前对高酸、马厩、皮革气息反馈不稳定。
```

## Tone

The agent should feel like a knowledgeable friend at the bar:

- Direct
- Specific
- Not snobby
- Willing to say “skip this one”
- Honest about uncertainty
- Preference-aware instead of score-worshipping

