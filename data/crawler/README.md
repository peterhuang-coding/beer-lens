# data/crawler

This directory holds crawler outputs and checkpoints for `bin/beer-lens-crawl.mjs`.

```
data/crawler/
  untappd/
    beers.jsonl          # one BeerRecord per line, UTF-8 (see CONTRACT.md)
    .state.json          # resume checkpoint — written on SIGINT/SIGTERM
  ratebeer/
    beers.jsonl
    .state.json
  _logs/                 # daily jsonl audit logs (YYYY-MM-DD.jsonl)
```

## Conventions

- First line of each `*.jsonl` is `_meta` (source + license_note + generated_at).
- Heartless principle: NO check-in / heart / follow / private fields.
- All writes are atomic — `.state.json.tmp` then rename to `.state.json`.
- `--resume` reads `<source>/.state.json`; never resume without verifying
  `processed_ids` count against the most recent JSONL.
