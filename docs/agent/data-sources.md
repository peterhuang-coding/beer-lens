# Data Sources

## Source Strategy

Beer Lens should use multiple sources, but the user's private taste profile is the long-term product advantage.

## Priority Order

### 1. User Taste Database

Use for:

- fit score
- style preference
- hop preference
- aroma and mouthfeel preference
- context matching

This is the strongest signal after enough entries exist.

### 2. Menu OCR And User Input

Use for:

- current candidates
- price
- serving size
- draft/bottle/can status
- venue-specific availability

OCR must preserve raw text for later correction.

### 3. Venue Website Or Published Tap List

Use for:

- current availability
- freshness or release date
- special events
- official beer descriptions

This is often more important than a public beer database because it answers: "Can the user drink this tonight?"

### 4. Beer Databases

Use for:

- canonical beer and brewery matching
- style
- ABV
- public rating
- broad popularity

Important caveat:

Do not build the core product by copying restricted third-party beer databases. Treat these sources as lookup/enrichment layers according to their terms.

### 5. Map And Place APIs

Use for:

- nearby venue discovery
- venue identity
- opening hours
- distance
- place rating

This helps answer whether the beer is available nearby, but map ratings are venue ratings, not beer ratings.

### 6. Social Web

Use for:

- recent mentions
- local availability hints
- qualitative notes
- hype and crowd sentiment

Do not treat social posts as canonical facts. Use them as soft evidence.

## Evidence Confidence

Every candidate should track:

- source
- confidence
- timestamp if known
- whether it is factual or inferred

Examples:

```json
{
  "source": "ocr",
  "summary": "Menu line reads 'Green City - Other Half - Hazy IPA - 7%'",
  "confidence": 0.88
}
```

```json
{
  "source": "agent_inference",
  "summary": "Likely good fit because user has rated tropical Hazy IPA highly.",
  "confidence": 0.74
}
```

## Data Source Risks

- Public API access may be limited or revoked.
- Venue tap lists may be stale.
- OCR can confuse brewery and beer names.
- Social media data is noisy and can be legally or technically hard to use.
- Public rating does not equal personal fit.

## MVP Data Plan

Start with:

1. User input and OCR
2. Manual beer candidate correction
3. User feedback benchmark
4. Private taste profile
5. Optional web search enrichment when needed

Add external integrations only after the loop feels good.

