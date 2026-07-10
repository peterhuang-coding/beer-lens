# PRD 07 - Beer Recommendation Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan.

**Goal:** Create a new recommendation module under `lib/beer-agent/recommendation/` that scores beer candidates using user profiles and constraints, selects picks, builds Chinese reply text, and rewrites the menu-recommend handler.

**Architecture:** Pure algorithmic scoring (no LLM) using profile memory, short-term constraints, and beer database lookup for enrichment. Four modules: types, scoring, pick-selector, reply-builder.

**Tech Stack:** TypeScript, Node.js, existing BeerResult data layer, ProfileMemory, ShortTermMemory.

---

### Task 1: Create `lib/beer-agent/recommendation/types.ts`

**Files:**
- Create: `lib/beer-agent/recommendation/types.ts`

- [ ] **Write types.ts**

```typescript
export type CandidateInput = {
  displayName: string;
  brewery?: string;
  style?: string;
  abv?: number;
  price?: number | null;
  volumeMl?: number | null;
  confidence?: number;
};

export type ScoredCandidate = {
  candidateId: string;
  menuIndex: number;
  displayName: string;
  brewery: string;
  style: string;
  abv: number;
  price: number | null;
  volumeMl: number | null;
  worthScore: number;
  fitScore: number;
  riskFlags: string[];
  reason: string;
  rating?: number | null;
  ratingsCount?: number | null;
  source?: string;
};

export type PickResult = {
  topPick: { candidateId: string; label: string; reason: string; worthScore: number; fitScore: number };
  safePick: { candidateId: string; label: string; reason: string; worthScore: number; fitScore: number };
  explorePick: { candidateId: string; label: string; reason: string; worthScore: number; fitScore: number };
  avoidOrCaution: { candidateId: string; label: string; reason: string; worthScore: number; fitScore: number };
};
```

### Task 2: Create `lib/beer-agent/recommendation/scoring.ts`

**Files:**
- Create: `lib/beer-agent/recommendation/scoring.ts`

- [ ] **Write scoring.ts**

Calculate `worthScore` (0-100):
- Has rating (rating > 0) → base = rating * 20
- No rating → base = 50, risk flag: "无评分数据"
- Price value bonus: if price/volumeMl <= 0.015 → +5 (good value)
- Risk penalties: no style/brewery data (-5), ABV > 8% (-5), ABV > 10% (-10, also add risk flag "高酒精度")

Calculate `fitScore` (0-100):
- Default base: 50
- Profile matching: preferredStyles (+15), dislikedStyles (-10)
- Preferred tags: +2 per tag match in style/name
- Disliked tags: -2 per tag match
- ABV in comfort range → +10, outside → -5
- Constraint "清爽": boost crisp/light styles (+10), low ABV <5% (+5)
- Constraint "IPA": boost IPA styles (+10)
- Constraint "不苦": penalize bitter styles (-10), add risk flag "可能偏苦"
- Constraint "拉格"/"lager": boost lager/pils styles (+10)

`reason`: Build Chinese explanation string per candidate.

### Task 3: Create `lib/beer-agent/recommendation/pick-selector.ts`

**Files:**
- Create: `lib/beer-agent/recommendation/pick-selector.ts`

- [ ] **Write pick-selector.ts**

Rules:
- topPick: highest combined (worthScore + fitScore), label "最佳"
- safePick: highest fitScore among "safe" styles (pale ale, pilsner, lager, wheat, hefe, session IPA, kolsch, helles, blonde, cream ale), label "最稳"
- explorePick: highest worthScore among candidates with riskFlags.length > 0 OR fitScore < 65, label "尝新"
- avoidOrCaution: lowest fitScore overall, label "谨慎"
- Fallback: if any rule can't find a candidate, use topPick
- Edge case: empty candidates → all picks are empty

### Task 4: Create `lib/beer-agent/recommendation/reply-builder.ts`

**Files:**
- Create: `lib/beer-agent/recommendation/reply-builder.ts`

- [ ] **Write reply-builder.ts**

Format:
```
我会这样点：

1. {topPick name} - {topPick reason}
2. {safePick name} - {safePick reason}
3. {explorePick name} - {explorePick reason}

最稳：{safePick name}
最值得尝新：{explorePick name}
我会先跳过：{avoidPick name}

如果只能喝一杯，选 {topPick name}。
```

### Task 5: Create `lib/beer-agent/recommendation/index.ts`

**Files:**
- Create: `lib/beer-agent/recommendation/index.ts`

- [ ] **Write index.ts**

Re-export all public types and functions.

### Task 6: Update `lib/beer-agent/handlers/menu-recommend.ts`

**Files:**
- Modify: `lib/beer-agent/handlers/menu-recommend.ts`

- [ ] **Rewrite menu-recommend.ts**

Import and use:
- `batchLookupBeers` from data-layer.ts
- `getProfileMemory` from memory/profile.ts
- `readShortTermMemory` from memory/short-term.ts
- `scoreCandidates` from recommendation/scoring.ts
- `selectPicks` from recommendation/pick-selector.ts
- `buildRecommendationReply` from recommendation/reply-builder.ts
- Types from dialog-types.ts, handler-types.ts, types.ts

Flow:
1. Extract beer names from user text (last message, split by newlines/delimiters)
2. If image, OCR via tesseractOcr to get text then parse
3. Call batchLookupBeers with extracted names
4. Build ScoredCandidate[] from lookup results
5. Get profile via getProfileMemory(userId)
6. Read constraints from readShortTermMemory(conversationId)
7. Call scoreCandidates → selectPicks → buildRecommendationReply
8. Convert ScoredCandidate[] → BeerCandidate[] for AgentResponse
9. Return AgentResponse with reply, candidates, picks, profileSummary

### Task 7: Verify

- [ ] **Run build**

Run: `cd /Volumes/SanDisk2TB/beer_researcher && npm run build`
Expected: Build succeeds with no TypeScript errors.
Fix any errors found.
