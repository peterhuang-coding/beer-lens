# lib/crawler shared contract

All 4 agents must align on these types/interfaces. Define them identically in `lib/crawler/contracts.ts` in your worktree. The merge step will treat these as authoritative.

## Core types

```ts
export type Source = "untappd" | "ratebeer";
export type CrawlMode = "live" | "dry-run" | "replay";

export interface BeerRecord {
  source: Source;
  source_id: string;            // untappd beer_id or ratebeer beer_id
  name: string;
  brewery_id: string | null;
  style: string | null;
  abv: number | null;
  ibu: number | null;
  rating: number | null;        // 0-5
  rating_count: number | null;
  description: string | null;
  labels: string[];              // tags
  food_pairing: string[];
  similar_ids: string[];
  url: string;
  fetched_at: string;            // ISO
}

export interface CrawlProgress {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  eta_seconds: number | null;
}

export interface CrawlOptions {
  source: Source;
  concurrency: number;          // default 2, hard cap 4
  limit: number | null;          // null = no limit
  dry_run: boolean;
  resume: boolean;
  tag: string | null;            // "china" | "craft" | null
  cookies: CookieRef[];          // dev-mode: file://refs
  retry_budget: number;          // default 5
  output_dir: string;            // "data/crawler/untappd" | "ratebeer"
}

export interface CookieRef {
  name: string;
  file: string;                  // local fixture path (NEVER prod)
  qps_per_cookie: number;        // default 1
}

export interface CrawlDriver {
  readonly mode: "puppeteer" | "http";
  fetchPage(url: string, opts: FetchOpts): Promise<PageSnapshot>;
  close(): Promise<void>;
}

export interface PageSnapshot {
  url: string;
  html: string;
  status: number;
  retry_after_ms: number | null;
}

export interface FetchOpts {
  cookie: CookieRef;
  jitter_ms: number;
  timeout_ms: number;
}

export interface BackoffPolicy {
  initial_ms: number;            // 1000
  max_ms: number;                // 60000
  multiplier: number;            // 2
  jitter_ratio: number;          // 0.3
}
```

## Output JSONL format

`data/crawler/<source>/beers.jsonl` — one BeerRecord per line, UTF-8, no pretty-print.
First line of each file (header metadata):

```jsonl
{"_meta": {"source": "untappd", "license_note": "untappd public pages; no check-in/heart; dev-mode replay", "generated_at": "..."}}
{"source_id":"12345", "name":"...", ...}
```

## Test conventions

- File: `tests/crawler/<name>.test.mts` (use `.mts` per existing pattern)
- Run: `node --experimental-strip-types --test tests/crawler/<name>.test.mts`
- Each agent MUST add ≥5 unit tests for their module

## Forbidden

- ❌ Real production Untappd cookies
- ❌ Concurrency > 4
- ❌ Any POST / PUT / DELETE
- ❌ Check-in / heart / personal data
- ❌ Copy-paste of any private/closed-source code

## Required before declaring done

1. `npm run typecheck` (tsc --noEmit) → 0 error in YOUR worktree
2. `node --experimental-strip-types --test tests/crawler/<name>.test.mts` → all pass
3. `git status` clean (only intentional untracked for `data/crawler/_logs/`)
4. Commit with conventional prefix (`feat(crawler): ...` or `test(crawler): ...`)
5. Write handoff to `agents/<role>.md` in your worktree