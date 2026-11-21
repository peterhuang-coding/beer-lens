#!/usr/bin/env python3
"""
Idempotent importer for the curated El Nido 2026-10 menu supplement.

Standard library only. Two write effects, inside ONE transaction:

  1. menu_supplements(menu_id, entry_id, payload) — ALL 17 full JSON records
     (upsert by primary key; repeating the import rewrites the same 17 rows).
  2. beer_cache — ONE row per *confirmed canonical identity* (15), and only when
     no exact casefold(name)+casefold(brewery) identity already exists in
     beers / untappd_cache / beer_cache. rating is always NULL: verified=1 means
     "identity reviewed against public sources", it is never a score.

Entries #11 (version_unresolved) and #17 (batch_unresolved) live in
menu_supplements only. No existing row is ever updated or deleted, and no old
table is migrated. The entire payload is validated and the existing schema is
preflighted BEFORE any write transaction is opened, so a failure is atomic.

Run on a backup/staging copy first:
    python3 scripts/import-menu-supplement.py \
        --db /path/to/beer.db --catalog data/menus/elnido-2026-10.json
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from typing import Any

MENU_ID = "elnido-2026-10"
EXPECTED_VERSION = 1
CHECKED_AT = "2026-10-21"
SOURCE_PLATFORM = "curated_public_menu"
VALID_STATUSES = {"confirmed", "version_unresolved", "batch_unresolved"}
VALID_SOURCE_KINDS = {"brewery", "retailer", "community"}

BEER_CACHE_REQUIRED_COLUMNS = {
    "name", "brewery", "style", "abv", "rating", "ratings_count",
    "source_url", "source_platform", "verified", "verified_at",
}
IDENTITY_TABLES = ("beers", "untappd_cache", "beer_cache")


class CatalogError(ValueError):
    """Payload failed validation before any DB write was attempted."""


class SchemaError(RuntimeError):
    """Required existing schema is missing; nothing was written."""


def _is_finite_number(value: Any) -> bool:
    """Booleans are not numeric payloads; NaN/Infinity are rejected."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


# ── Payload validation (entire file, before any write) ──

def _require_type(obj: Any, key: str, typ: type | tuple[type, ...], entry_id: str) -> Any:
    if not isinstance(obj, dict) or key not in obj or not isinstance(obj[key], typ):
        raise CatalogError(f"{entry_id or '<root>'}: field {key!r} missing or wrong type")
    return obj[key]


def validate_catalog(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        raise CatalogError("catalog root must be an object")
    if payload.get("version") != EXPECTED_VERSION:
        raise CatalogError(f"version must equal {EXPECTED_VERSION}")
    if payload.get("menu_id") != MENU_ID:
        raise CatalogError(f"menu_id must equal {MENU_ID!r}")
    entries = payload.get("entries")
    if not isinstance(entries, list) or len(entries) != 17:
        raise CatalogError("entries must be an array of exactly 17 records")

    seen_indexes: set[int] = set()
    seen_ids: set[str] = set()
    confirmed = 0
    unresolved = 0

    for pos, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise CatalogError(f"entry position {pos}: not an object")
        eid = str(entry.get("id", f"<position {pos}>"))
        for key in ("id", "menu_name", "name_zh", "brewery", "description_zh"):
            if not isinstance(entry.get(key), str) or not entry[key].strip():
                raise CatalogError(f"{eid}: {key!r} must be a non-empty string")
        if entry["id"] in seen_ids:
            raise CatalogError(f"duplicate entry id {entry['id']}")
        seen_ids.add(entry["id"])

        idx = entry.get("menu_index")
        if not isinstance(idx, int) or isinstance(idx, bool) or not (2 <= idx <= 18):
            raise CatalogError(f"{eid}: menu_index must be an integer 2..18")
        if idx in seen_indexes:
            raise CatalogError(f"{eid}: duplicate menu_index {idx}")
        seen_indexes.add(idx)

        for key in ("brewery_aliases", "aliases", "issues"):
            val = entry.get(key)
            if not isinstance(val, list) or not all(isinstance(v, str) for v in val):
                raise CatalogError(f"{eid}: {key!r} must be a string array")
        if not isinstance(entry.get("field_disagreements"), dict):
            raise CatalogError(f"{eid}: field_disagreements must be an object")

        status = entry.get("identity_status")
        if status not in VALID_STATUSES:
            raise CatalogError(f"{eid}: identity_status {status!r} invalid")

        cn = entry.get("canonical_name")
        style = entry.get("style")
        abv = entry.get("abv")
        if status == "confirmed":
            confirmed += 1
            if not isinstance(cn, str) or not cn.strip():
                raise CatalogError(f"{eid}: confirmed record needs canonical_name")
            if not isinstance(style, str) or not style.strip():
                raise CatalogError(f"{eid}: confirmed record needs public canonical style")
            if not _is_finite_number(abv) or abv <= 0:
                raise CatalogError(f"{eid}: confirmed record needs public canonical abv")
        else:
            unresolved += 1
            if cn is not None or style is not None or abv is not None:
                raise CatalogError(
                    f"{eid}: {status} record must keep canonical_name/style/abv null"
                )

        obs = entry.get("observation")
        if not isinstance(obs, dict):
            raise CatalogError(f"{eid}: observation must be an object")

        def _non_negative_obs_field(key: str) -> None:
            val = obs.get(key)
            if not _is_finite_number(val) or val < 0:
                raise CatalogError(f"{eid}: observation.{key} must be a finite non-negative number")

        _non_negative_obs_field("abv")
        _non_negative_obs_field("price")
        _non_negative_obs_field("volume_ml")
        if obs.get("currency") != "CNY":
            raise CatalogError(f"{eid}: observation.currency must be 'CNY'")
        if obs.get("observed_at") != "2026-10-20" or obs.get("source") != "menu_transcription":
            raise CatalogError(f"{eid}: observation provenance must be the 2026-10-20 transcription")

        sources = entry.get("sources")
        if not isinstance(sources, list) or not sources:
            raise CatalogError(f"{eid}: sources must be a non-empty array")
        for src in sources:
            if not isinstance(src, dict):
                raise CatalogError(f"{eid}: source must be an object")
            url = src.get("url", "")
            if not isinstance(url, str) or not url.startswith("https://"):
                raise CatalogError(f"{eid}: source url must be https")
            if src.get("kind") not in VALID_SOURCE_KINDS:
                raise CatalogError(f"{eid}: source kind invalid")
            if src.get("access") != "web_index_or_cache":
                raise CatalogError(f"{eid}: source access must be web_index_or_cache")
            if src.get("checked_at") != CHECKED_AT:
                raise CatalogError(f"{eid}: source checked_at must be {CHECKED_AT}")
            fields = src.get("fields")
            if not isinstance(fields, list) or not fields or not all(
                isinstance(f, str) and f.strip() for f in fields
            ):
                raise CatalogError(f"{eid}: source fields must be a non-empty string array")

    if seen_indexes != set(range(2, 19)):
        raise CatalogError("menu_index set must be exactly taps 2..18")
    if confirmed != 15 or unresolved != 2:
        raise CatalogError(f"expected 15 confirmed + 2 unresolved, got {confirmed} + {unresolved}")
    return entries


def load_catalog(path: str) -> list[dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as fh:
        payload = json.load(fh)
    return validate_catalog(payload)


# ── Schema preflight (read-only, before the write transaction) ──

def _table_columns(conn: sqlite3.Connection, table: str) -> set[str] | None:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    if row is None:
        return None
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def preflight_schema(conn: sqlite3.Connection) -> dict[str, set[str]]:
    columns: dict[str, set[str]] = {}
    for table in IDENTITY_TABLES:
        cols = _table_columns(conn, table)
        if cols is None:
            raise SchemaError(f"required table {table!r} is missing; no migration is performed")
        if "name" not in cols or "brewery" not in cols:
            raise SchemaError(f"table {table!r} must expose name and brewery columns")
        columns[table] = cols
    missing = BEER_CACHE_REQUIRED_COLUMNS - columns["beer_cache"]
    if missing:
        raise SchemaError(f"beer_cache is missing required columns: {sorted(missing)}")
    return columns


# ── Import (single atomic transaction) ──

def _primary_source_url(entry: dict[str, Any]) -> str:
    sources = entry["sources"]
    for src in sources:
        if src["kind"] == "brewery":
            return src["url"]
    return sources[0]["url"]


def _existing_identities(conn: sqlite3.Connection) -> set[tuple[str, str]]:
    identities: set[tuple[str, str]] = set()
    for table in IDENTITY_TABLES:
        for name, brewery in conn.execute(f"SELECT name, brewery FROM {table}"):
            if isinstance(name, str) and isinstance(brewery, str):
                identities.add((name.casefold(), brewery.casefold()))
    return identities


def import_supplement(db_path: str, entries: list[dict[str, Any]]) -> dict[str, Any]:
    conn = sqlite3.connect(db_path)
    try:
        columns = preflight_schema(conn)  # read-only; raises before any write
        identities = _existing_identities(conn)

        inserted: list[str] = []
        preserved: list[str] = []
        unresolved: list[str] = []

        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS menu_supplements ("
                "menu_id TEXT NOT NULL, "
                "entry_id TEXT NOT NULL, "
                "payload TEXT NOT NULL, "
                "PRIMARY KEY (menu_id, entry_id)"
                ")"
            )

            # 1) All 17 full records, upserted.
            for entry in entries:
                conn.execute(
                    "INSERT INTO menu_supplements(menu_id, entry_id, payload) VALUES (?, ?, ?) "
                    "ON CONFLICT(menu_id, entry_id) DO UPDATE SET payload=excluded.payload",
                    (MENU_ID, entry["id"],
                     json.dumps(entry, ensure_ascii=False, separators=(",", ":"))),
                )

            # 2) Confirmed canonical identities only, never overwriting existing data.
            cache_cols = columns["beer_cache"]
            insert_cols = ["name", "brewery", "style", "abv", "rating", "ratings_count",
                           "source_url", "source_platform", "verified", "verified_at"]
            if "created_at" in cache_cols:
                insert_cols.append("created_at")
            placeholders = ",".join("?" for _ in insert_cols)
            sql = f"INSERT INTO beer_cache ({','.join(insert_cols)}) VALUES ({placeholders})"

            for entry in entries:
                if entry["identity_status"] != "confirmed":
                    unresolved.append(entry["id"])
                    continue
                key = (entry["canonical_name"].casefold(), entry["brewery"].casefold())
                if key in identities:
                    preserved.append(entry["id"])
                    continue
                row = {
                    "name": entry["canonical_name"],
                    "brewery": entry["brewery"],
                    "style": entry["style"],
                    "abv": float(entry["abv"]),
                    "rating": None,          # verified identity, NOT a rating
                    "ratings_count": None,
                    "source_url": _primary_source_url(entry),
                    "source_platform": SOURCE_PLATFORM,
                    "verified": 1,
                    "verified_at": CHECKED_AT,
                    "created_at": CHECKED_AT,
                }
                conn.execute(sql, [row[c] for c in insert_cols])
                identities.add(key)
                inserted.append(entry["id"])

            conn.commit()
        except Exception:
            conn.rollback()
            raise
    finally:
        conn.close()

    return {
        "menu_id": MENU_ID,
        "menu_entries": len(entries),
        "menu_rows_written": len(entries),
        "confirmed_identities": len(inserted) + len(preserved),
        "unresolved_menu_only": unresolved,
        "beer_cache_inserted": len(inserted),
        "beer_cache_preserved": len(preserved),
        "beer_cache_inserted_ids": inserted,
        "beer_cache_preserved_ids": preserved,
    }


def main(argv: list[str] | None = None) -> dict[str, Any]:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="Path to the SQLite beer database")
    parser.add_argument("--catalog", required=True, help="Path to elnido-2026-10.json")
    args = parser.parse_args(argv)

    try:
        entries = load_catalog(args.catalog)
    except (OSError, json.JSONDecodeError, CatalogError) as exc:
        print(json.dumps({"error": f"catalog validation failed: {exc}"}, ensure_ascii=False),
              file=sys.stderr)
        raise SystemExit(2)

    try:
        report = import_supplement(args.db, entries)
    except (sqlite3.Error, SchemaError) as exc:
        print(json.dumps({"error": f"import failed atomically: {exc}"}, ensure_ascii=False),
              file=sys.stderr)
        raise SystemExit(2)

    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return report


if __name__ == "__main__":
    main()
