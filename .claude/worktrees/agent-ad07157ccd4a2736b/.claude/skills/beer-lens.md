---
name: beer-lens
description: >-
  Beer Lens — an autonomous beer recommendation agent. Analyzes menu photos,
  recommends beers based on personal taste profile, records tasting feedback,
  and learns preferences over time. Built with Next.js + OpenRouter + PaddleOCR.
metadata:
  type: project
  tags: [beer, ai-agent, ocr, recommendation, nextjs, openrouter]
  author: Peter
  version: "2.0"
---

# Beer Lens — 啤酒推荐 Agent

An autonomous beer recommendation agent that learns your taste.

## Quick Start

```bash
cd /Volumes/SanDisk2TB/beer_researcher
npm run dev                    # → http://localhost:3000
npm run demo -- --image ./menu.jpg --text "推荐清爽的"
npm run demo -- --feedback "喝了 Green City，4.5分，会再喝，柑橘味"
```

## Architecture

```
User (chat.html) → POST /api/agent → agent.ts → OpenRouter LLM
                                   ↓
                              Journal + Profile (JSON/MD on disk)
```

### Key files

| File | Role |
|------|------|
| `lib/beer-agent/agent.ts` | **Core agent** — intent routing (menu→recommend, feedback→record, text→chat) |
| `lib/beer-agent/journal.ts` | Tasting journal CRUD + profile stats + recommendation cache |
| `lib/beer-agent/profile.ts` | Legacy profile (markdown-based, being replaced) |
| `lib/beer-agent/benchmark.ts` | Feedback parser (extracts score, tags, beer name from natural language) |
| `lib/beer-agent/types.ts` | Shared types (BeerCandidate, AgentRequest/Response, JournalEntry) |
| `lib/beer-agent/multi-stage-pipeline.ts` | **Deprecated** — old 4-stage pipeline, replaced by agent.ts |
| `lib/beer-agent/openrouter-client.ts` | OpenRouter HTTP client with proxy support |
| `lib/beer-agent/tesseract-ocr.ts` | OCR module (PaddleOCR primary, Tesseract fallback) |
| `scripts/paddle_ocr.py` | PaddleOCR Python wrapper (PP-OCRv5, en model) |
| `lib/beer-agent/beer-db/enricher.ts` | Untappd enrichment (batch lookup + web verification) |
| `lib/beer-agent/beer-db/value-calc.ts` | Origin-country pricing benchmarks (12 countries) |
| `app/api/agent/route.ts` | API endpoint — thin wrapper around agent.ts |
| `public/chat.html` | Frontend UI — chat interface with candidate cards |

## Data Model

### Beer Candidate
```typescript
{
  candidateId: string, displayName: string, brewery: string, style: string,
  abv: number, ibu?: number, hops: string[],
  price?: number, volumeMl?: number, pricePerMl?: number,
  untappdScore?: number, untappdRatingCount?: number,
  breweryCountry?: string, originBenchmark?: number, savingsVsOrigin?: number,
  worthScore: number, fitScore: number, riskFlags: string[], reason: string
}
```

### Tasting Entry (journal)
```typescript
{
  id: string, createdAt: string,
  beerName: string, brewery: string, breweryCountry: string,
  style: string, abv: number, hops: string[],
  rating: number (1-5), wouldDrinkAgain: "yes"|"maybe"|"no",
  tasteTags: string[], aromaTags: string[], note: string
}
```

### Data files
```
data/
  beer_journal.json          # Tasting history (TastingEntry[])
  beer_profile.md            # Human-readable taste profile
  beer_cache.json            # Untappd response cache
  last_recommendation.json   # Cached from last menu analysis (for feedback matching)
  ocr_tmp/                   # Temp OCR image files
```

## Agent Intent Routing

```
request.messages.last + image → agent decides:

  1. hasImage → analyzeImage (vision model) → enrichBeers (Untappd) → score → sort → cache
  2. looksLikeFeedback ("4.5分 会再喝") → parse → match last cache → writeJournal → confirm
  3. otherwise → chat (text model with profile + history context)
```

## Environment

```bash
# .env.local
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_VISION_MODEL=nvidia/nemotron-nano-12b-v2-vl:free  # OCR/vision
OPENROUTER_ANALYSIS_MODEL=openai/gpt-4o-mini                  # Text analysis
OPENROUTER_PROXY=http://127.0.0.1:7890                        # Clash proxy
```

## Adding Features

### New intent
1. Add detection function in `agent.ts` (like `looksLikeFeedback`)
2. Add handler function
3. Return `AgentResponse`

### New country benchmark
Edit `beer-db/value-calc.ts` → `COUNTRY_BENCHMARKS` → add row

### Switch vision model
Change `OPENROUTER_VISION_MODEL` in `.env.local`

### Switch OCR engine
Edit `tesseract-ocr.ts` — primary/secondary functions

## Troubleshooting

| Symptom | Check |
|---------|-------|
| OCR returns 0 beers | Image quality, try clearer photo |
| API timeout | Proxy (Clash) running? `curl -x http://127.0.0.1:7890 https://openrouter.ai` |
| JSON parse errors | Model output malformed — `escapeControlCharsInJsonStrings` handles most cases |
| PaddleOCR fails | Python deps: `pip3 install paddlepaddle paddleocr` |
| Port conflict | `pkill -f "next dev"` then restart |
