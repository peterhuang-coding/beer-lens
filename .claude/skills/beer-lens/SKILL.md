---
name: beer-lens
description: Use when working on Beer Lens purchase recommendations, price/value comparisons, product examples, beer data collection, or project verification.
---

# Beer Lens project workflows

Run from the repository root (the folder containing package.json). Do not assume a specific user's absolute path or a private SQLite database.

## Purchase decisions and product examples

Beer Lens aims to answer which beer is worth buying for this user, at this price, within this budget. For recommendation work or product presentation, read [purchase-decision.md](../../../docs/purchase-decision.md); use its current capability boundaries and acceptance scenarios rather than treating the target example as implemented behavior.

- Show the actual serving price and volume, the preferred choice, a meaningful alternative and its price difference. Consider budget, desired quantity, taste and evidence together. A larger serving's lower unit price does not automatically make it a better purchase.
- Calculate price per 100ml only with valid price, volume and currency. Compare market offers only when beer identity, specification, currency, consumption format, source and observation time support the comparison. Hardcoded historical benchmarks are not current market evidence.
- Separate unit cost, beer quality and personal fit. Do not invent a universal value score by dividing a rating by price. Missing ratings do not prevent arithmetic, but they limit quality claims.
- For feedback design, bind the actual purchased beer, paid price and serving to the recommendation. Distinguish taste feedback, willingness to buy again at that price, factual corrections and proposed method changes; a global method change requires evaluation.
- Lead product examples with the user's purchasing decision. Label designed target replies separately from actual responses. For an actual QA, inspect the original request, image and response; preserve quoted wording, label excerpts and link a sanitized record. Resolve conflicts with summaries before reusing precise claims.

## Verification and handoff

Read [testing.md](../../../docs/testing.md) when reporting capability. Code tests, schema checks, real API assertions and actual task success are different evidence. Inspect selected entities, constraints, price arithmetic and persisted state, including cases marked PASS. Configuration saved is not proof it took effect at runtime.

At a milestone, use the available wrapup skill to save evidence, decisions and remaining work in the local project memory. Keep personal records and private evidence out of public commits. When the user says to stop or wrap up, finish only the authorized handoff; a recorded next step is not permission to resume development or create an automation.

## Existing project commands

- Offline beer lookup: `npm run cli -- --name "Flying Fist" --source json --json`.
- Generate collection targets: `npm run --silent crawl:round -- --limit 10 --print`. This only plans work; it does not collect or verify facts.
- Prioritize explicit gaps: optional `data/warm-list-gaps.json`, an array of `{ "name": "...", "brewery": "..." }`. User targets can be supplied with `--targets PATH`.
- Inspect data fields, skill files and recent collection logs: `npm run --silent inspector -- --print`. The inspector does not run tests. Run `npm test` for regression results.
- Start local read-only Skill Hub: `npm run hub:serve`, default http://127.0.0.1:8888. It shows seed statistics, collection logs, real historical snapshots and project features.
- Web conversation: `npm run dev`, then open `/chat`. Review existing cases at `/debug` → Cases; do not assume every current chat run automatically creates a Case.
- Current crawler implementation: `npm run crawl:cli -- --help`; import supplied CSV with `npm run import-untappd-csv -- --help`.

## Data honesty

Seed ratings are dated snapshots, not live verified scores. Preserve source URLs and rating scales; do not invent missing ABV, ratings or counts. When the user asks for live information, use available web search and cross-check the exact beer and brewery. A first search result is not automatically a verified identity. If a website denies access, report the limitation.

After an actual authorized collection, write an explicit status to `data/crawl-log.jsonl` including timestamp, name, brewery, source URLs and verified/skipped/failed. Do not log a target-generation run as a successful collection. Historical statistics can be stored in `data/snapshots/stats-YYYY-MM-DD.json` as `{ "date": "YYYY-MM-DD", "total_beers": 298, "verified_entries": 0 }`, using measured values.

Optional local `.beer-data` files may support legacy lookup; they are not a required install dependency. New work should use the tracked TypeScript/JSON interfaces. Do not schedule unattended collection or publish new datasets unless the user requests it.
