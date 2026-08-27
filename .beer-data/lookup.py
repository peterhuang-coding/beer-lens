#!/usr/bin/env python3
"""
Beer lookup — query local SQLite beer database.
Returns JSON. Callable from Node.js via child_process.

Usage:
  python3 lookup.py "Pseudo Sue"
  python3 lookup.py --batch "Pseudo Sue|King Sue|Green City"
  python3 lookup.py --stats
  python3 lookup.py --init
  python3 lookup.py --upsert-untappd <json-file-or-stdin>
  python3 lookup.py --report-untappd-nulls

Subcommands:
  --init                  Ensure unique indexes are present, log duplicate groups
                          and any NULL untappd_cache ids to
                          data/beer-db-update.json (does NOT auto-delete
                          duplicate rows — leaves that for the user).
  --upsert-untappd <JSON> Transactional upsert of Untappd results. Input is
                          a JSON array of records:
                            [{ "name", "brewery", "style", "abv",
                               "rating", "ratings_count", "untappd_url",
                               "untappd_id", "country", "label_image" }, …]
                          Writes data/raw-crawl/update-log.json on commit.
                          Returns { "inserted", "updated", "skipped",
                          "errors" }.
  --report-untappd-nulls  Apply one-shot SQL fixup:
                          UPDATE untappd_cache SET id = lower(hex(randomblob(8)))
                          WHERE id IS NULL
                          Returns count fixed.
"""

import sqlite3
import json
import sys
import os
import re
import hashlib
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "beer.db"
UPDATE_LOG_DIR = Path(__file__).resolve().parent.parent / "data"
UPDATE_LOG_PATH = UPDATE_LOG_DIR / "beer-db-update.json"
UPDATE_HISTORY_PATH = UPDATE_LOG_DIR / "raw-crawl" / "update-log.json"


def _connect():
    if not DB_PATH.exists():
        return None
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    return con


def _ensure_beer_cache(con):
    """Ensure beer_cache table exists."""
    con.execute("""
        CREATE TABLE IF NOT EXISTS beer_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            brewery TEXT NOT NULL,
            style TEXT,
            abv REAL,
            rating REAL,
            ratings_count INTEGER,
            ibu REAL,
            source_url TEXT,
            source_platform TEXT,
            verified INTEGER DEFAULT 0,
            verified_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(name, brewery)
        )
    """)


def ensure_untappd_cache_schema(con):
    """Ensure untappd_cache table has the right schema (country, untappd_url, label_image)."""
    con.execute("""
        CREATE TABLE IF NOT EXISTS untappd_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            brewery TEXT,
            style TEXT,
            abv REAL,
            rating REAL,
            ratings_count INTEGER,
            country TEXT,
            untappd_url TEXT,
            label_image TEXT,
            source TEXT DEFAULT 'untappd',
            updated_at TEXT DEFAULT (datetime('now'))
        )
    """)


def ensure_indexes(con, exclude_ids: list[int] | None = None):
    """Create the unique composite indexes (#9 hardening).

    Strategy:
      - Add a `legacy_dup` boolean column on `beers` (default 0).
      - Mark the 18 grandfathered duplicate groups with legacy_dup=1.
      - Build the unique index over rows WHERE legacy_dup = 0
        (SQLite allows bound params in expression predicates but not in
        WHERE literals — using a column reference keeps it portable).

    New rows are not allowed to collide with each other or with any
    legacy-dup row. Legacy rows are exempt until the user resolves
    them via the audit log entry in data/beer-db-update.json.
    """
    exclude_ids = exclude_ids or []

    # Add + backfill the legacy_dup column (idempotent).
    cols = {row[1] for row in con.execute("PRAGMA table_info(beers)").fetchall()}
    if "legacy_dup" not in cols:
        try:
            con.execute("ALTER TABLE beers ADD COLUMN legacy_dup INTEGER DEFAULT 0")
            con.commit()
        except Exception:
            pass  # already exists (e.g., race)

    if exclude_ids:
        placeholders = ",".join("?" * len(exclude_ids))
        con.execute(
            f"UPDATE beers SET legacy_dup = 1 WHERE id IN ({placeholders})",
            exclude_ids,
        )

    # Case-insensitive secondary indexes that align with the lookup path.
    con.execute(
        "CREATE INDEX IF NOT EXISTS ix_beers_name_lower ON beers(LOWER(name))"
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS ix_beers_brewery_lower ON beers(LOWER(brewery))"
    )

    # Drop any old non-partial version, then re-create as partial over
    # the legacy_dup column predicate.
    con.execute("DROP INDEX IF EXISTS ux_beers_name_brewery")
    con.execute("""
        CREATE UNIQUE INDEX ux_beers_name_brewery
            ON beers(LOWER(name), LOWER(brewery))
            WHERE legacy_dup = 0
    """)



def report_duplicate_groups(con, limit: int = 100):
    """Report (but do not delete) duplicate (name, brewery) groups in beers."""
    rows = con.execute(
        """
        SELECT LOWER(name) AS key_name, LOWER(brewery) AS key_brewery,
               COUNT(*) AS dup_count,
               GROUP_CONCAT(id) AS ids
        FROM beers
        GROUP BY LOWER(name), LOWER(brewery)
        HAVING COUNT(*) > 1
        ORDER BY dup_count DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [
        {
            "name": r["key_name"],
            "brewery": r["key_brewery"],
            "count": r["dup_count"],
            "ids": r["ids"].split(",") if r["ids"] else [],
        }
        for r in rows
    ]


def fixup_untappd_nulls(con) -> int:
    """One-shot SQL fallback for NULL untappd_cache.id rows."""
    cur = con.execute("SELECT COUNT(*) FROM untappd_cache WHERE id IS NULL")
    nulls = cur.fetchone()[0]
    if nulls == 0:
        return 0
    con.execute(
        "UPDATE untappd_cache SET id = lower(hex(randomblob(8))) WHERE id IS NULL"
    )
    con.commit()
    return nulls


def init_db() -> dict:
    """Idempotent schema/index/null fixup + write audit log entry."""
    con = _connect()
    if not con:
        return {"error": "Database not found"}
    _ensure_beer_cache(con)
    ensure_untappd_cache_schema(con)
    duplicate_groups = report_duplicate_groups(con)
    # For each duplicate group, keep the lowest id as the "keeper" (legacy_dup=0)
    # and mark the rest as legacy_dup=1 so they don't break the unique index.
    # All dup ids are still recorded in data/beer-db-update.json for arbitration.
    legacy_ids: list[int] = []
    for g in duplicate_groups:
        ids: list[int] = []
        for raw_id in g["ids"]:
            try:
                ids.append(int(raw_id))
            except (TypeError, ValueError):
                pass
        ids.sort()
        legacy_ids.extend(ids[1:])  # skip keeper
    ensure_indexes(con, exclude_ids=legacy_ids)
    con.commit()

    duplicate_groups = report_duplicate_groups(con)
    null_count = fixup_untappd_nulls(con)

    audit = {
        "initializedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "indexes": ["ux_beers_name_brewery"],
        "duplicate_groups_count": len(duplicate_groups),
        "duplicate_groups": duplicate_groups[:20],
        "untappd_null_ids_fixed": null_count,
    }

    # Append to data/beer-db-update.json (do not delete duplicates automatically)
    UPDATE_LOG_DIR.mkdir(parents=True, exist_ok=True)
    existing: dict = {}
    if UPDATE_LOG_PATH.exists():
        try:
            existing = json.loads(UPDATE_LOG_PATH.read_text())
        except Exception:
            existing = {}
    existing["lastInit"] = audit["initializedAt"]
    existing["initialization"] = audit
    if duplicate_groups:
        existing.setdefault("warnings", []).append(
            f"{len(duplicate_groups)} duplicate (name, brewery) groups in beers "
            f"— left in place for manual resolution"
        )
    if null_count > 0:
        existing.setdefault("warnings", []).append(
            f"Backfilled {null_count} NULL untappd_cache.id rows"
        )
    UPDATE_LOG_PATH.write_text(json.dumps(existing, indent=2, ensure_ascii=False) + "\n")

    con.close()
    return audit


# ── Untappd upsert (transactional) ──


def upsert_untappd(payload) -> dict:
    """Transactional upsert of Untappd results into untappd_cache.

    payload: a JSON array (or single record object) shaped like:
        { "name": str, "brewery": str, "style": str, "abv": num,
          "rating": num, "ratings_count": int, "untappd_url": str,
          "untappd_id": str, "country": str, "label_image": str }

    Returns a structured JSON envelope:

        { "inserted": int, "updated": int, "skipped": int,
          "errors": [{ "name": str, "reason": str }],
          "total": int, "startedAt": str, "completedAt": str }

    On commit, appends an entry to data/raw-crawl/update-log.json.
    """
    if isinstance(payload, dict):
        records = [payload]
    elif isinstance(payload, list):
        records = payload
    else:
        return {"error": "Payload must be a JSON object or array"}

    started_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    con = _connect()
    if not con:
        return {"error": "Database not found"}

    ensure_untappd_cache_schema(con)
    inserted = 0
    updated = 0
    skipped = 0
    errors: list[dict] = []
    payload_checksum = hashlib.sha256(
        json.dumps(records, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:16]

    try:
        # Single transaction across the whole batch
        for rec in records:
            try:
                name = (rec.get("name") or "").strip()
                brewery = (rec.get("brewery") or "").strip()
                if not name:
                    errors.append({"name": "", "reason": "missing name"})
                    continue

                style = (rec.get("style") or "").strip() or "Unknown"
                abv = rec.get("abv") or 0
                rating = rec.get("rating") or 0
                ratings_count = rec.get("ratings_count") or 0
                country = rec.get("country") or ""
                untappd_url = rec.get("untappd_url") or ""
                label_image = rec.get("label_image") or ""
                untappd_id = rec.get("untappd_id") or ""

                # Look up existing by (name, brewery) case-insensitively
                row = con.execute(
                    "SELECT id, rating, ratings_count FROM untappd_cache "
                    "WHERE LOWER(name) = ? AND LOWER(brewery) = ?",
                    (name.lower(), brewery.lower()),
                ).fetchone()

                if row is None:
                    # INSERT
                    if not untappd_id:
                        # Generate a stable id if upstream didn't provide one
                        untappd_id = hashlib.sha256(
                            f"{name.lower()}|{brewery.lower()}".encode()
                        ).hexdigest()[:16]
                    con.execute(
                        """INSERT INTO untappd_cache
                           (id, name, brewery, style, abv, rating, ratings_count,
                            country, untappd_url, label_image, source, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
                        (
                            untappd_id,
                            name,
                            brewery,
                            style,
                            abv,
                            rating,
                            ratings_count,
                            country,
                            untappd_url,
                            label_image,
                            rec.get("source") or "untappd",
                        ),
                    )
                    inserted += 1
                else:
                    existing_id = row["id"]
                    old_rating = row["rating"] or 0
                    # Update if rating or count changed meaningfully
                    if (
                        abs((rating or 0) - old_rating) > 0.005
                        or ratings_count != (row["ratings_count"] or 0)
                    ):
                        con.execute(
                            """UPDATE untappd_cache SET
                               style = ?, abv = ?, rating = ?, ratings_count = ?,
                               country = ?, untappd_url = ?, label_image = ?,
                               updated_at = datetime('now')
                               WHERE id = ?""",
                            (
                                style,
                                abv,
                                rating,
                                ratings_count,
                                country,
                                untappd_url,
                                label_image,
                                existing_id,
                            ),
                        )
                        updated += 1
                    else:
                        skipped += 1
            except Exception as e:  # noqa: BLE001
                errors.append({"name": rec.get("name", ""), "reason": str(e)})

        con.commit()
    except Exception as e:  # noqa: BLE001
        con.rollback()
        return {"error": f"transaction failed: {e}"}
    finally:
        con.close()

    completed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    log_entry = {
        "timestamp": completed_at,
        "source": "untappd",
        "kind": "upsert",
        "payloadChecksum": payload_checksum,
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "errorCount": len(errors),
        "total": len(records),
        "startedAt": started_at,
        "completedAt": completed_at,
    }

    UPDATE_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    history: list = []
    if UPDATE_HISTORY_PATH.exists():
        try:
            history = json.loads(UPDATE_HISTORY_PATH.read_text())
        except Exception:
            history = []
    if not isinstance(history, list):
        history = []
    history.append(log_entry)
    # Keep last 100 entries
    history = history[-100:]
    UPDATE_HISTORY_PATH.write_text(
        json.dumps(history, indent=2, ensure_ascii=False) + "\n"
    )

    return {
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
        "total": len(records),
        "startedAt": started_at,
        "completedAt": completed_at,
        "logEntry": log_entry,
    }


# ── Search ──


def search_beer(query: str, limit: int = 5) -> list[dict]:
    """Search beer_cache (verified, priority), untappd_cache, then RateBeer."""
    con = _connect()
    if not con:
        return []

    _ensure_beer_cache(con)

    q = re.sub(r'\s+', ' ', query.strip().lower())
    results = []

    # Try progressively shorter queries: "beer name brewery" → "beer name" → "beer"
    for attempt_q in _expand_queries(q):
        # Priority 0: Verified beer_cache (hand-curated, cross-referenced)
        results = _search_table(con, 'beer_cache', attempt_q, limit)
        if results:
            for r in results:
                r['source'] = 'beer_cache'
                r['verified'] = True
            con.close()
            return results

        # Priority 0.5: exact-name hits across both data tables (before fuzzy)
        exact_hits = _search_exact_both(con, attempt_q, limit)
        if exact_hits:
            con.close()
            return exact_hits

        # Priority 1: Untappd cache
        results = _search_table(con, 'untappd_cache', attempt_q, limit)
        if results:
            for r in results:
                r['source'] = 'untappd'
            con.close()
            return results

        # Priority 2: RateBeer database
        results = _search_table(con, 'beers', attempt_q, limit)
        if results:
            for r in results:
                r['source'] = 'ratebeer'
            con.close()
            return results

    # Last resort: brewery match
    rows = con.execute(
        """SELECT * FROM beers WHERE LOWER(brewery) LIKE ? ORDER BY rating DESC LIMIT ?""",
        (f"%{q}%", limit)
    ).fetchall()
    if rows:
        results = [_row_to_dict(r) for r in rows]
        for r in results:
            r['source'] = 'ratebeer'
        con.close()
        return results

    con.close()
    return []


def _expand_queries(q: str) -> list[str]:
    """Expand 'beer name brewery' into progressively shorter queries.
    e.g. 'pseudo sue toppling goliath' → ['pseudo sue', 'pseudo'] """
    words = q.split()
    # Start with all words, then drop the last one progressively
    queries = []
    for n in range(len(words), 1, -1):
        queries.append(' '.join(words[:n]))
    # Also try just the first word (in case it's distinctive)
    if words:
        queries.append(words[0])
    return queries


def _search_exact_both(con, q: str, limit: int) -> list[dict]:
    """Exact-name matches across untappd_cache + beers, before any fuzzy path.

    防止模糊 LIKE 高分酒抢在精确同名酒前面(如 "Lunch" 只走 untappd
    会错配 "Dutch IPA - Lemons for Lunch",而 beers 表里有精确的 Lunch)。
    """
    out = []
    for table in ('untappd_cache', 'beers'):
        cols = "id, name, brewery, style, abv, rating, ratings_count"
        if table == 'untappd_cache':
            cols += ", untappd_url, country, label_image"
        rows = con.execute(
            f"SELECT {cols} FROM {table} WHERE LOWER(name) = ? ORDER BY ratings_count DESC LIMIT ?",
            (q, limit)
        ).fetchall()
        out.extend(_row_to_dict(r, table) for r in rows)
        # 撇号归一: "Becks" 也要能命中 "Beck's"(2026-08-28 实测暴露)
        if not out:
            rows = con.execute(
                f"SELECT {cols} FROM {table} WHERE REPLACE(LOWER(name), '''', '') = ? ORDER BY ratings_count DESC LIMIT ?",
                (q.replace("'", "").replace("’", ""), limit)
            ).fetchall()
            out.extend(_row_to_dict(r, table) for r in rows)
    return out


def _search_table(con, table: str, q: str, limit: int) -> list[dict]:
    """Search a table by beer name (exact, then fuzzy, then multi-word)."""
    # Normalize column names between tables
    cols = "id, name, brewery, style, abv, rating, ratings_count"
    if table == 'untappd_cache':
        cols = "id, name, brewery, style, abv, rating, ratings_count, untappd_url, country, label_image"
    else:
        cols = "id, name, brewery, style, abv, rating, ratings_count"

    # Exact match
    rows = con.execute(
        f"SELECT {cols} FROM {table} WHERE LOWER(name) = ? ORDER BY ratings_count DESC LIMIT ?",
        (q, limit)
    ).fetchall()
    if rows:
        return [_row_to_dict(r, table) for r in rows]

    # Fuzzy match
    rows = con.execute(
        f"SELECT {cols} FROM {table} WHERE LOWER(name) LIKE ? ORDER BY ratings_count DESC LIMIT ?",
        (f"%{q}%", limit)
    ).fetchall()
    if rows:
        return [_row_to_dict(r, table) for r in rows]

    # Multi-word: match all words
    words = q.split()
    if len(words) >= 2:
        conditions = " AND ".join([f"LOWER(name) LIKE ?" for _ in words])
        params = [f"%{w}%" for w in words] + [limit]
        rows = con.execute(
            f"SELECT {cols} FROM {table} WHERE {conditions} ORDER BY ratings_count DESC LIMIT ?",
            params
        ).fetchall()
        if rows:
            return [_row_to_dict(r, table) for r in rows]

    return []


def search_batch(queries: list[str]) -> list[dict]:
    """Search multiple beers at once. Returns results in same order."""
    results = []
    for q in queries:
        matches = search_beer(q, limit=1)
        if matches:
            # Score confidence: exact match = high, fuzzy = medium
            m = matches[0]
            q_lower = q.strip().lower()
            name_lower = m['name'].lower()
            if q_lower == name_lower:
                m['confidence'] = 'exact'
            elif q_lower in name_lower or name_lower in q_lower:
                m['confidence'] = 'high'
            else:
                m['confidence'] = 'medium'
            results.append(m)
        else:
            results.append({
                'query': q,
                'found': False,
                'confidence': 'none'
            })
    return results


def get_stats() -> dict:
    """Return database statistics."""
    con = _connect()
    if not con:
        return {'error': 'Database not found'}

    _ensure_beer_cache(con)

    total = con.execute("SELECT COUNT(*) FROM beers").fetchone()[0]
    breweries = con.execute("SELECT COUNT(DISTINCT brewery) FROM beers").fetchone()[0]
    styles = con.execute("SELECT COUNT(DISTINCT style) FROM beers").fetchone()[0]
    avg_rating = con.execute("SELECT AVG(rating) FROM beers").fetchone()[0]
    top_styles = [dict(r) for r in con.execute(
        "SELECT style, COUNT(*) as count, ROUND(AVG(rating),2) as avg_rating FROM beers GROUP BY style HAVING count >= 50 ORDER BY count DESC LIMIT 10"
    ).fetchall()]

    # beer_cache stats
    cache_total = con.execute("SELECT COUNT(*) FROM beer_cache").fetchone()[0]
    cache_verified = con.execute("SELECT COUNT(*) FROM beer_cache WHERE verified = 1").fetchone()[0]

    # Untappd cache stats
    untappd_total = con.execute("SELECT COUNT(*) FROM untappd_cache").fetchone()[0]
    untappd_null_ids = con.execute(
        "SELECT COUNT(*) FROM untappd_cache WHERE id IS NULL"
    ).fetchone()[0]

    # Index presence (cheap query)
    indexes = [r['name'] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='beers'"
    ).fetchall()]
    has_unique_index = 'ux_beers_name_brewery' in indexes

    con.close()
    return {
        'total_beers': total,
        'total_breweries': breweries,
        'total_styles': styles,
        'avg_rating': round(avg_rating, 2) if avg_rating else 0,
        'top_styles': top_styles,
        'source': 'RateBeer Kaggle Dataset (1.58M reviews)',
        'beer_cache': {
            'total': cache_total,
            'verified': cache_verified,
            'description': 'Hand-verified entries from WebSearch cross-reference'
        },
        'untappd_cache': {
            'total': untappd_total,
            'null_ids': untappd_null_ids,
        },
        'db_indexes': indexes,
        'ux_beers_name_brewery_present': has_unique_index,
    }


def _row_to_dict(row, table: str = 'beers') -> dict:
    """Convert a database row to dict. Handles both beers and untappd_cache tables."""
    result = {
        'id': row['id'],
        'name': row['name'],
        'brewery': row['brewery'],
        'style': row['style'],
        'abv': round(row['abv'], 1) if row['abv'] else None,
        'rating': row['rating'],
        'ratings_count': row['ratings_count'],
        'source': 'untappd' if table == 'untappd_cache' else 'ratebeer',
        'found': True,
    }
    # Extra fields from ratebeer
    try:
        result['review_aroma'] = row['review_aroma']
        result['review_appearance'] = row['review_appearance']
        result['review_palate'] = row['review_palate']
        result['review_taste'] = row['review_taste']
    except (IndexError, KeyError):
        pass
    # Extra fields from untappd cache
    try:
        result['untappd_url'] = row['untappd_url']
        result['country'] = row['country']
        result['label_image'] = row['label_image']
    except (IndexError, KeyError):
        pass
    return result


def insert_cn_beers(json_file: str) -> dict:
    """Insert Chinese craft beers from a JSON file into untappd_cache."""
    with open(json_file, 'r', encoding='utf-8') as f:
        beers = json.load(f)

    con = _connect()
    if not con:
        return {'error': 'Database not found'}

    ensure_untappd_cache_schema(con)
    inserted = 0
    skipped = 0
    errors = []

    for beer in beers:
        name = beer.get('name', '').strip()
        brewery = beer.get('brewery', '').strip()
        if not name:
            continue

        # Check if already exists (by name + brewery)
        existing = con.execute(
            "SELECT id FROM untappd_cache WHERE LOWER(name) = ? AND LOWER(brewery) = ?",
            (name.lower(), brewery.lower())
        ).fetchone()

        if existing:
            skipped += 1
            continue

        try:
            con.execute(
                """INSERT INTO untappd_cache
                   (name, brewery, style, abv, rating, ratings_count, country, source)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    name,
                    brewery,
                    beer.get('style', ''),
                    beer.get('abv'),
                    beer.get('rating'),
                    beer.get('ratings_count', 0),
                    beer.get('country', 'China'),
                    'cn_seed'
                )
            )
            inserted += 1
        except Exception as e:
            errors.append(f"{name}: {str(e)}")

    con.commit()
    total = con.execute("SELECT COUNT(*) FROM untappd_cache WHERE source = 'cn_seed'").fetchone()[0]
    con.close()

    return {
        'inserted': inserted,
        'skipped': skipped,
        'errors': errors,
        'total_cn_beers': total
    }


def insert_beers(json_file: str) -> dict:
    """Insert beers from a JSON file into the beers table (for RateBeer crawler)."""
    with open(json_file, 'r', encoding='utf-8') as f:
        beers = json.load(f)

    con = _connect()
    if not con:
        return {'error': 'Database not found'}

    inserted = 0
    updated = 0
    skipped = 0

    for beer in beers:
        name = beer.get('name', '').strip()
        brewery = beer.get('brewery', '').strip()
        if not name:
            continue

        existing = con.execute(
            "SELECT id, rating FROM beers WHERE LOWER(name) = ? AND LOWER(brewery) = ?",
            (name.lower(), brewery.lower())
        ).fetchone()

        if existing:
            old_rating = existing['rating']
            new_rating = beer.get('rating', 0)
            if abs(old_rating - new_rating) > 0.05:
                con.execute(
                    "UPDATE beers SET rating = ?, ratings_count = ?, style = ?, abv = ? WHERE id = ?",
                    (new_rating, beer.get('ratings_count', 0), beer.get('style', ''),
                     beer.get('abv'), existing['id'])
                )
                updated += 1
            else:
                skipped += 1
        else:
            con.execute(
                """INSERT INTO beers (name, brewery, style, abv, rating, ratings_count)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (name, brewery, beer.get('style', ''), beer.get('abv'),
                 beer.get('rating', 0), beer.get('ratings_count', 0))
            )
            inserted += 1

    con.commit()
    con.close()
    return {'inserted': inserted, 'updated': updated, 'skipped': skipped}


def _read_payload(arg: str) -> object:
    """Resolve a `--upsert-untappd` argument: either a JSON file path or '-' for stdin."""
    if arg == '-':
        return json.loads(sys.stdin.read())
    path = Path(arg)
    if path.exists():
        return json.loads(path.read_text())
    # Treat the argument itself as inline JSON
    try:
        return json.loads(arg)
    except Exception:
        return {"error": f"Could not read payload from {arg}"}


def run_audit() -> dict:
    """数据体检 — 供 selfcheck/测评使用。

    对两表做字段级缺失/异常/重复/新鲜度审计,回答「哪条数据的哪个字段
    需要补爬」:价格无字段、abv/style/country 缺失、url 畸形、缓存过期等。
    """
    con = _connect()
    if not con:
        return {"error": "Database not found"}

    def one(sql):
        return con.execute(sql).fetchone()[0]

    audit = {"generated_at": datetime.now(timezone.utc).isoformat()}

    u = {}
    u["total"] = one("SELECT COUNT(*) FROM untappd_cache")
    u["style_null"] = one("SELECT COUNT(*) FROM untappd_cache WHERE style IS NULL OR style=''")
    u["abv_null"] = one("SELECT COUNT(*) FROM untappd_cache WHERE abv IS NULL")
    u["rating_null"] = one("SELECT COUNT(*) FROM untappd_cache WHERE rating IS NULL")
    u["ratings_count_zero"] = one("SELECT COUNT(*) FROM untappd_cache WHERE ratings_count IS NULL OR ratings_count=0")
    u["label_image_missing"] = one("SELECT COUNT(*) FROM untappd_cache WHERE label_image IS NULL OR label_image=''")
    u["country_null"] = one("SELECT COUNT(*) FROM untappd_cache WHERE country IS NULL OR country=''")
    u["url_malformed"] = one("SELECT COUNT(*) FROM untappd_cache WHERE untappd_url IS NULL OR untappd_url='' OR untappd_url NOT LIKE 'http%'")
    u["country_china"] = one("SELECT COUNT(*) FROM untappd_cache WHERE country='China'")
    u["stale_gt90d"] = one(
        "SELECT COUNT(*) FROM untappd_cache WHERE updated_at < (strftime('%s','now') - 90*86400)*1000"
    )
    u["updated_max_ms"] = one("SELECT MAX(updated_at) FROM untappd_cache")
    u["dup_name_groups"] = one(
        "SELECT COUNT(*) FROM (SELECT LOWER(name) FROM untappd_cache GROUP BY LOWER(name) HAVING COUNT(*)>1)"
    )
    u["brewery_count"] = one("SELECT COUNT(DISTINCT brewery) FROM untappd_cache")
    u["has_price_column"] = False  # 无价格字段:价值估算走 origin 基准,价格为缺口
    audit["untappd_cache"] = u

    b = {}
    b["total"] = one("SELECT COUNT(*) FROM beers")
    b["abv_null"] = one("SELECT COUNT(*) FROM beers WHERE abv IS NULL")
    b["rating_null"] = one("SELECT COUNT(*) FROM beers WHERE rating IS NULL")
    b["ratings_count_null"] = one("SELECT COUNT(*) FROM beers WHERE ratings_count IS NULL")
    b["style_null"] = one("SELECT COUNT(*) FROM beers WHERE style IS NULL OR style=''")
    b["dup_name_brewery_groups"] = one(
        "SELECT COUNT(*) FROM (SELECT LOWER(name), LOWER(brewery) FROM beers GROUP BY LOWER(name), LOWER(brewery) HAVING COUNT(*)>1)"
    )
    # NOT EXISTS + LOWER 双表对比在 14k×50k 上要 30s,改 Python 端集合计算
    untappd_names = {
        row[0] for row in con.execute("SELECT LOWER(name) FROM untappd_cache WHERE name IS NOT NULL")
    }
    b["not_in_untappd"] = sum(
        1 for (name,) in con.execute("SELECT name FROM beers")
        if not name or name.lower() not in untappd_names
    )
    audit["beers"] = b

    con.close()
    return audit


def search_brewery_untappd(q: str, limit: int = 5) -> dict:
    """酒厂级检索 — 具体酒款查不到时,返回该厂在 untappd_cache 的统计与代表款。"""
    con = _connect()
    if not con:
        return {"query": q, "found": False, "error": "Database not found"}
    ql = q.strip().lower()
    if not ql:
        con.close()
        return {"query": q, "found": False}

    cols = "id, name, brewery, style, abv, rating, ratings_count, untappd_url, country, label_image"
    # 先精确酒厂名,再词边界 LIKE:(' ' || brewery || ' ') LIKE '% raft %'
    # 防止 raft→Craft、stamm→Stammtisch 类子串假命中(2026-08-28 实测暴露)
    boundary = f"% {ql} %"
    rows = con.execute(
        f"SELECT {cols} FROM untappd_cache WHERE LOWER(brewery) = ? ORDER BY ratings_count DESC LIMIT ?",
        (ql, limit)
    ).fetchall()
    if not rows:
        rows = con.execute(
            f"SELECT {cols} FROM untappd_cache WHERE (' ' || LOWER(brewery) || ' ') LIKE ? ORDER BY ratings_count DESC LIMIT ?",
            (boundary, limit)
        ).fetchall()
    stats = con.execute(
        "SELECT COUNT(*) AS n, ROUND(AVG(rating),2) AS avg_rating, SUM(ratings_count) AS total_ratings "
        "FROM untappd_cache WHERE LOWER(brewery) = ? OR (' ' || LOWER(brewery) || ' ') LIKE ?",
        (ql, boundary)
    ).fetchone()
    out = {
        "query": q,
        "found": bool(rows),
        "brewery_stats": {"count": stats[0] or 0, "avg_rating": stats[1], "total_ratings": stats[2] or 0},
        "top_beers": [_row_to_dict(r, 'untappd_cache') for r in rows],
    }
    con.close()
    return out


def main():
    args = sys.argv[1:]

    if not args:
        print(json.dumps({"error": (
            "Usage: lookup.py <beer_name> | --batch <name1|name2|...> | --stats | --audit | --brewery <name> | "
            "--init | --upsert-untappd <json-file-or-stdin> | "
            "--report-untappd-nulls | --insert-cn-beers <json> | --insert-beers <json>"
        )}))
        sys.exit(1)

    cmd = args[0]
    if cmd == '--stats':
        result = get_stats()
    elif cmd == '--audit':
        result = run_audit()
    elif cmd == '--brewery':
        if len(args) < 2:
            print(json.dumps({"error": "--brewery requires a brewery name"}))
            sys.exit(1)
        result = search_brewery_untappd(args[1])
    elif cmd == '--batch':
        if len(args) < 2:
            print(json.dumps({"error": "--batch requires pipe-separated beer names"}))
            sys.exit(1)
        queries = [q.strip() for q in args[1].split('|') if q.strip()]
        result = search_batch(queries)
    elif cmd == '--init':
        result = init_db()
    elif cmd == '--report-untappd-nulls':
        con = _connect()
        if not con:
            result = {"error": "Database not found"}
        else:
            fixed = fixup_untappd_nulls(con)
            con.close()
            result = {"untappd_null_ids_fixed": fixed}
    elif cmd == '--upsert-untappd':
        if len(args) < 2:
            print(json.dumps({"error": "--upsert-untappd requires a JSON file path or '-' for stdin"}))
            sys.exit(1)
        payload = _read_payload(args[1])
        result = upsert_untappd(payload)
    elif cmd == '--insert-cn-beers':
        if len(args) < 2:
            print(json.dumps({"error": "--insert-cn-beers requires JSON file path"}))
            sys.exit(1)
        result = insert_cn_beers(args[1])
    elif cmd == '--insert-beers':
        if len(args) < 2:
            print(json.dumps({"error": "--insert-beers requires JSON file path"}))
            sys.exit(1)
        result = insert_beers(args[1])
    else:
        query = ' '.join(args)
        matches = search_beer(query)
        result = {
            'query': query,
            'results': matches,
            'total_found': len(matches)
        }

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
