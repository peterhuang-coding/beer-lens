---
name: beer-lens
description: Query Beer Lens beer data, generate collection target rounds, inspect project health, or open its local Skill Hub. Use for this project's beer research workflows.
---

# Beer Lens project workflows

Run from the repository root (the folder containing package.json). Do not assume a specific user's absolute path or a private SQLite database.

- Offline beer lookup: `npm run cli -- --name "Flying Fist" --source json --json`.
- Generate collection targets: `npm run --silent crawl:round -- --limit 10 --print`. This only plans work; it does not collect or verify facts.
- Prioritize explicit gaps: optional `data/warm-list-gaps.json`, an array of `{ "name": "...", "brewery": "..." }`. User targets can be supplied with `--targets PATH`.
- Inspect data fields, skill files and recent collection logs: `npm run --silent inspector -- --print`. The inspector does not run tests. Run `npm test` for regression results.
- Start local read-only Skill Hub: `npm run hub:serve`, default http://127.0.0.1:8888. It shows seed statistics, collection logs, real historical snapshots and project features.
- Web conversation: `npm run dev`, then open `/chat`. Review recorded cases at `/debug` → Cases.
- Current crawler implementation: `npm run crawl:cli -- --help`; import supplied CSV with `npm run import-untappd-csv -- --help`.

## Data honesty

Seed ratings are dated snapshots, not live verified scores. Preserve source URLs and rating scales; do not invent missing ABV, ratings or counts. When the user asks for live information, use available web search and cross-check the exact beer and brewery. A first search result is not automatically a verified identity. If a website denies access, report the limitation.

After an actual authorized collection, write an explicit status to `data/crawl-log.jsonl` including timestamp, name, brewery, source URLs and verified/skipped/failed. Do not log a target-generation run as a successful collection. Historical statistics can be stored in `data/snapshots/stats-YYYY-MM-DD.json` as `{ "date": "YYYY-MM-DD", "total_beers": 298, "verified_entries": 0 }`, using measured values.

Optional local `.beer-data` files may support legacy lookup; they are not a required install dependency. New work should use the tracked TypeScript/JSON interfaces. Do not schedule unattended collection or publish new datasets unless the user requests it.
