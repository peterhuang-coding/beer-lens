---
name: beer-lens
description: Help someone choose craft beer from a menu, tap list, cooler, or beer-label photo. Use whenever the user asks which beer to buy, compares prices or serving sizes, sets a budget or taste constraint, asks about a numbered beer from the current menu, or wants an evidence-backed beer identification. Works with Chinese or English input and does not require the user to sign in to Untappd.
---

# Beer Lens

Turn a beer menu into a purchase decision. The valuable output is not a list of ratings; it is a short, evidence-aware answer to “which one should I buy this time, and what is the trade-off?”

## Workflow

1. Determine whether the input is a new menu, a single label, or a follow-up about the active menu.
2. For a new menu, extract every visible offer before recommending. Keep the printed row number, beer name, brewery, style, ABV, IBU, price, currency, serving size, and the original row text. Use `null` for unknown facts; never turn unknown into zero.
3. Keep the complete menu as the active snapshot. A follow-up such as “第 2 款呢” changes the focused offer, not the stored menu. If “第 2 款” could mean the printed menu order or the assistant’s ranked list, ask which one.
4. Resolve identities cautiously. An exact beer-and-brewery match may add a public rating and source link. A brewery average, search snippet, nearby name, or marketing claim is not the beer’s rating. External lookup is optional and must not block price arithmetic.
5. Translate the user’s current request into explicit constraints. Numeric budget, ABV, IBU, excluded style, and requested style are hard constraints. “清爽”“不太苦”“想尝新” are preferences unless the user gives a numeric bound. Unknown values do not pass a hard constraint.
6. Run the bundled decision helper with the structured offers. Resolve paths relative to this `SKILL.md`:

   ```bash
   node scripts/decide-menu.mjs --input menu.json
   ```

   The helper accepts stdin when `--input` is omitted. Do not replace its arithmetic or exclusions with an improvised rating-divided-by-price score.
7. Reply with at most three useful choices: first choice, meaningful alternative, and an optional exploration choice. Show actual price and serving size, unit price when comparable, price difference, the constraints satisfied, and important unknowns. If nothing is confirmed eligible, say so instead of filling recommendation slots.

## Decision input

```json
{
  "currency": "CNY",
  "constraints": {
    "maxPrice": 70,
    "maxAbv": 7,
    "maxIbu": 35,
    "avoidStyles": ["stout"],
    "preferredStyles": ["lager"],
    "notBitter": true,
    "priceGoal": "balanced"
  },
  "offers": [
    {
      "index": 1,
      "name": "Example Lager",
      "brewery": "Example Brewery",
      "style": "Lager",
      "price": 55,
      "volumeMl": 425,
      "abv": 5,
      "ibu": null,
      "rating": null,
      "ratingCount": null
    }
  ]
}
```

`priceGoal` is `total`, `unit`, or `balanced`. `unit` is valid only for offers with known price and volume. A lower unit price never overrides the total budget. `balanced` keeps quality, fit, evidence, and price as separate reasons; it does not claim a universal value score.

## Evidence and wording

- Attribute ratings to their platform and include rating count when available.
- Distinguish menu facts, external facts, user preferences, and assistant inference.
- Say “这几款可比报价中单位价最低”, not “全网最低” or “市场最划算”, unless same-beer comparable external offers with source and observation time are available.
- IBU is bitterness evidence, not a guarantee of perceived bitterness. When IBU is unknown, style can only support a cautious inference.
- Do not require an Untappd login. If a public source is unavailable, continue with menu facts and mark rating or identity as unverified.
- Do not retain or upload menu images, location, conversation history, purchases, or taste feedback unless the user explicitly asks for persistence or contribution.

## Follow-up and feedback

Use the active menu for budget changes, style filters, and numbered questions. A newly supplied menu replaces it only after extraction succeeds; if extraction fails, explain that the previous menu is not being treated as the new image.

Recommendation is not purchase. Record a purchase or feedback only after the user identifies the beer or confirms the selected offer. Keep “liked the taste” separate from “would buy again at this price.”

## Failure behavior

- No readable offers: ask for a clearer image or pasted menu text.
- Ambiguous identity: show the ambiguity and avoid attaching a rating.
- Missing price or volume: answer identity/taste questions, but do not calculate unit price.
- Provider unavailable: use local/menu evidence and state what could not be verified.
- No confirmed match after hard constraints: explain which constraints or unknown fields blocked the decision.
