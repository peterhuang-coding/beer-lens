# MBCB red/Rat (鼠场) catalog — local SQLite lookup

Atomic import and read-only full-text search for the MBCB Beijing 2026 red
session catalog (`event_id = mbcb-2026-beijing`). Stdlib Python only; the
Feishu bot answers catalog commands directly through a subprocess — no LLM,
no model API, no network.

## Files

- `scripts/mbcb-catalog.py` — import/query CLI (Python 3 stdlib `sqlite3`).
- `lib/feishu/mbcb.ts` — `handleMbcbQuery(text, opts?)`, used by the Feishu handler.
- `lib/feishu/handler.ts` — one early text-only branch after reset; ordinary
  chat and images are unchanged.

## CLI

```sh
python3 scripts/mbcb-catalog.py --db .beer-data/beer.db --import records.json
python3 scripts/mbcb-catalog.py --db .beer-data/beer.db --query "Helles"
python3 scripts/mbcb-catalog.py --db .beer-data/beer.db --query "" --page 2
```

- `--db PATH` required; `--import JSON` and `--query STRING` are mutually exclusive.
- `--page N` is 1-based; page size is fixed at 20; invalid page exits non-zero
  with `{"ok": false, ...}` JSON on stdout.
- Import prints `{"ok": true, "event_id": ..., "imported": N}`; any validation
  failure prints `{"ok": false, "error": "..."}` and exits 1.

### Storage

One importer-owned table; legacy `beers`, `untappd_cache`, `beer_cache` are
never read or modified:

```sql
CREATE TABLE event_menu_beers (
  event_id      TEXT    NOT NULL,
  event_beer_id INTEGER NOT NULL,
  payload       TEXT    NOT NULL,           -- full original record JSON
  PRIMARY KEY (event_id, event_beer_id)
) WITHOUT ROWID;
```

The full record is stored verbatim, so unknown/extra fields survive.

### Atomic import

1. Every record is validated in memory before any DB connection writes.
2. One `BEGIN IMMEDIATE` transaction creates the table if needed, deletes only
   rows for `mbcb-2026-beijing`, and inserts the replacement snapshot.
3. Any error rolls the whole transaction back; repeating the same import is
   idempotent (replace, not append). An empty array is rejected and never
   deletes an existing catalog.

Validation rejects: non-array/empty batches, non-object records, wrong/mixed
`event_id`, non-positive-integer IDs (booleans rejected), duplicate
`event_beer_id`, duplicate non-null `untappd_id`, missing/non-string
`name`/`brewery`, sessions that are not a non-empty string list containing
`red`, non-finite or boolean `abv`/`rating_raw`, and invalid `rating_count`.
Production expects 147 records; smaller synthetic batches are allowed for
tests.

### Query semantics

Queries open the database with SQLite `mode=ro` and run no DDL. Output envelope:

```json
{"event_id": "mbcb-2026-beijing", "session": "red", "available": true,
 "total": 2, "page": 1, "page_size": 20, "results": [ /* original records */ ]}
```

- Missing DB file → `"available": false, "reason": "db_missing"`;
  DB exists without the catalog table → `"reason": "catalog_missing"`. Both
  exit 0 and are distinct from a successful zero-hit query
  (`"available": true, "total": 0`).
- `#424` → exact `event_beer_id`; an all-digits query → exact `untappd_id`.
- Text searches English/Chinese names, brewery names (incl. `brewery_zh`) and
  `aliases`. Every query token must match the same record, so unrelated
  brewery words cannot combine across records; ambiguous names return all
  candidates.
- Normalisation: NFKC, diacritic stripping, case folding, punctuation → space,
  whitespace collapse. ASCII tokens compare as whole tokens (`v1` ≠ `V10`);
  CJK tokens match as substrings (Chinese text has no word spaces).
- `abv: null` and `abv: 0` are distinct and both preserved.

## Feishu commands

| Command | Behaviour |
| --- | --- |
| `/mbcb` | first page: `#id name — brewery`, total and paging hints |
| `/mbcb <关键词>` | 1 hit → detail; several → candidates; 0 → search hint |
| `/mbcb 第2页` (also appended to a query) | pagination |
| `MBCB 第二场 …`, `MBCB 鼠场 …` | same red-session catalog |

Only messages that **start** with these explicit text patterns are handled;
the branch returns `null` for everything else and images are never intercepted.
Catalog replies bypass conversation history, model API and memory writes.

Detail view shows style, ABV (with the unresolved 4.5 vs 6.0 conflict flagged,
never auto-resolved), usable Untappd rating + count only when
`rating_usable` is true (`23` red ratings — 22 zero + 1 missing — render as
“暂无可用评分”), sessions, source URL and snapshot time, issue tags and
missing-field names. Unknown values render as `未知`; null ABV is explicitly
not 0%. Price, volume, booth and live stock are never displayed or inferred.

### Chinese paraphrase rule

`description_zh` is shown **only** when
`description_zh_review_status == "parent_spotchecked"`; for `pending_review`
and `no_source` records the original English description is used (or a
“source unavailable” note). Unreviewed `name_zh` values remain searchable and
are labelled `菜单中文名` (menu name), never presented as verified facts.

## Tests

```sh
python3 -m unittest discover -s tests/python -p test_mbcb_catalog.py -v
node --experimental-strip-types --test tests/mbcb-catalog.test.mts
```

Both suites use temporary SQLite databases with four public menu examples and synthetic records. The Node suite
spawns the real Python CLI (subprocess) and makes no network, API or memory
writes.

## Known limitations

- Feishu transport itself (sending/receiving messages, credentials) is not
  exercised here; parent verifies that separately.
- Only the red session is served; other sessions appear only via a record's
  retained `sessions` list.
- Publisher listing is not live stock; the snapshot reflects `retrieved_at`.
- Exact normalized ASCII token / CJK substring matching only — there is no fuzzy matching,
  spell correction, or synonym expansion.

## Included snapshot and current validation (2026-10-13)

The curated snapshot is `data/events/mbcb-2026-red.json`. It contains all 147
red-session entries in the publisher snapshot retrieved at
2026-10-12T16:36:40Z, including 146 Untappd IDs and one ice tea. Import it with:

```sh
python3 scripts/mbcb-catalog.py --db .beer-data/beer.db --import data/events/mbcb-2026-red.json
```

Source: [publisher menu](https://mbcb.jonpacker.com/),
[underlying snapshot endpoint](https://mbcb.jonpacker.com/latest.json).
This is our normalized and reviewed integration of public source data, not
147 independent brewery confirmations or a live-stock guarantee.

| Field | Known / usable entries |
| --- | ---: |
| English name and brewery | 147 |
| Chinese menu name, style and source description | 146 each |
| ABV | 144 |
| Usable rating | 124 |
| Price, serving volume, booth, live stock | 0 |

Three ABVs remain unknown (#127, #439, #498). The two Helles records (#96,
#599) have conflicting/duplicated Chinese menu names and remain separate
candidates. #424 preserves the 4.5% menu value with an unresolved 6% older
source conflict. 131 Chinese paraphrases are pending review and are not
shown by the Feishu command handler.

Independent local validation: 586/586 real-snapshot lookup cases and 19/19
import, paging and database-preservation checks passed. Project verification:
806 Node tests, 28 Python tests, typecheck and production build passed. The
last-page ambiguity regression was reproduced before the one-line uniqueness
fix; a sole item on page 2 is still a candidate when total matches exceed 1.

The isolated development database contains the 147-entry catalog; legacy
tables were unchanged and a local backup was retained. The database itself is
not part of this change. Local command formatting has been exercised against
that database. Feishu credentials/configuration and a bounded WebSocket
handshake passed, but real user-message receipt and reply are **not verified**.
Catalog commands are stateless; follow-up pronouns and unconstrained natural
language questions are not supplied this catalog through conversation memory.
The existing image/model route is unchanged and has not been revalidated here.
