# dev-cli-harness — CLI harness for beer-lens crawler

**Branch**: task/dev-cli-harness
**Commit**: 7244408 (off dca9244 main)

## Files (LoC)

| File | LoC |
|---|---|
| lib/crawler/contracts.ts | 133 |
| lib/crawler/cli.ts | 451 |
| lib/crawler/progress.ts | 100 |
| lib/crawler/error-aggregator.ts | 117 |
| lib/crawler/signal.ts | 102 |
| bin/beer-lens-crawl.mjs | 87 |
| tests/crawler-cli.test.mts | 351 |
| data/crawler/.gitkeep + README.md | - |
| package.json | +2 lines |

## Validation

- `npm run typecheck` -> 0 error
- `npm run crawl:test` -> 22/22 pass (~197ms; live/signal block ~5s)
- `node --experimental-strip-types bin/beer-lens-crawl.mjs --help` -> all 7 flags
- `bin/beer-lens-crawl.mjs --source untappd --concurrency 5` -> exits 2 with hard-cap message
- `git status --short` -> only `lib/crawler/CONTRACT.md` untracked (shared, intentional)

## --help output (first 10 lines)

```
Usage: beer-lens-crawl --source <untappd|ratebeer> [options]

Options:
  --source <name>       Source: untappd | ratebeer (required unless --help)
  --concurrency <n>     Concurrent in-flight pages (default 2, hard cap 4)
  --dry-run             Print plan; make ZERO network calls
  --limit <n>           Stop after n processed records
  --tag <name>          Filter tag: china | craft
  --resume              Continue from data/crawler/<source>/.state.json
  --help                Show this help and exit
```

## Run examples

```bash
npx beer-lens-crawl --source untappd --limit 100 --dry-run
npx beer-lens-crawl --source untappd --concurrency 3 --limit 50
npx beer-lens-crawl --source ratebeer --tag china --limit 30
npx beer-lens-crawl --source untappd --resume
```

## Required test cases (all pass)

- `--help` outputs all flags
- `--concurrency 5` throws CliArgError with hard-cap message
- `--dry-run` does NOT call worker hook
- SIGINT mid-run writes state.json with processed + failed ids
- Error aggregation 4xx/5xx/timeout/parser/cookie_ban (up to 3 samples each)

## Risks

1. Live-mode driver not wired in this worktree; bin defaults to dry-run unless BEER_LENS_LIVE=1; integration agent must wire driver/worker/candidateIds.
2. strip-types requires `import type` for shared interfaces — every consumer of contracts.ts uses it.
3. State-write is fire-and-forget on `kill -9`; periodic checkpoint recommended for long unattended runs.
4. CONTRACT.md left untracked on purpose (other agents own it).
5. `--concurrency` flag name collides with `node --test --concurrency`; tests invoke `node --test` directly.

## Next steps

- dev-puppeteer / dev-http: expose CrawlDriver + CookieRef impls.
- dev-integration: wire bin live-mode branch with real drivers + cookie pool.
- merge-verify: run `tsc --noEmit` + `npm test` on merged worktree.
