#!/usr/bin/env python3
"""MBCB Beijing 2026 red/Rat catalog: atomic SQLite import + read-only search.

Stdlib only. The importer owns exactly one table, ``event_menu_beers``, and
never touches legacy ``beers`` / ``untappd_cache`` / ``beer_cache`` tables.
Full record payloads are stored as JSON so unknown/extra fields are
preserved verbatim.
"""

import argparse
import json
import math
import os
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

EVENT_ID = "mbcb-2026-beijing"
RED_SESSION = "red"
TABLE = "event_menu_beers"
PAGE_SIZE = 20

SCHEMA = """
CREATE TABLE IF NOT EXISTS {table} (
    event_id      TEXT    NOT NULL,
    event_beer_id INTEGER NOT NULL,
    payload       TEXT    NOT NULL,
    PRIMARY KEY (event_id, event_beer_id)
) WITHOUT ROWID
""".format(table=TABLE)


class BatchError(Exception):
    """A user-correctable import/query error; reported as JSON, no traceback."""


def emit(obj, exit_code=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    raise SystemExit(exit_code)


def is_pos_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def is_finite_number(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


# ---------------------------------------------------------------------------
# Validation / import
# ---------------------------------------------------------------------------

def validate_batch(data):
    """Validate every record before any DB write; raise BatchError otherwise."""
    if not isinstance(data, list) or not data:
        raise BatchError("import batch must be a non-empty JSON array")
    seen_event_ids = set()
    seen_untappd = set()
    for index, rec in enumerate(data):
        if not isinstance(rec, dict):
            raise BatchError("record %d: expected JSON object" % index)
        if rec.get("event_id") != EVENT_ID:
            raise BatchError(
                "record %d: event_id must be exactly %r" % (index, EVENT_ID)
            )
        eid = rec.get("event_beer_id")
        if not is_pos_int(eid) or eid <= 0:
            raise BatchError("record %d: event_beer_id must be a positive integer" % index)
        if eid in seen_event_ids:
            raise BatchError("duplicate event_beer_id %d in batch" % eid)
        seen_event_ids.add(eid)

        sessions = rec.get("sessions")
        if (
            not isinstance(sessions, list)
            or not sessions
            or not all(isinstance(s, str) for s in sessions)
        ):
            raise BatchError("record %d: sessions must be a non-empty string list" % index)
        if RED_SESSION not in sessions:
            raise BatchError("record %d: red session membership is mandatory" % index)

        for field in ("name", "brewery"):
            value = rec.get(field)
            if not isinstance(value, str) or not value.strip():
                raise BatchError("record %d: %s must be a non-empty string" % (index, field))

        untappd = rec.get("untappd_id")
        if untappd is not None:
            if not is_pos_int(untappd) or untappd <= 0:
                raise BatchError("record %d: untappd_id must be null or a positive integer" % index)
            if untappd in seen_untappd:
                raise BatchError("duplicate untappd_id %d in batch" % untappd)
            seen_untappd.add(untappd)

        for field in ("abv", "rating_raw"):
            value = rec.get(field)
            if value is not None and not is_finite_number(value):
                raise BatchError(
                    "record %d: %s must be null or a finite number (booleans rejected)"
                    % (index, field)
                )
        count = rec.get("rating_count")
        if count is not None and (not is_pos_int(count) or count < 0):
            raise BatchError("record %d: rating_count must be null or a non-negative integer" % index)
        abv = rec.get("abv")
        if abv is not None and is_finite_number(abv) and abv < 0:
            raise BatchError("record %d: abv must not be negative" % index)
    return data


def cmd_import(db_path, json_path):
    try:
        with open(json_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as exc:
        raise BatchError("cannot read import file: %s" % type(exc).__name__)
    except json.JSONDecodeError as exc:
        raise BatchError("import file is not valid JSON: %s" % exc)

    records = validate_batch(data)

    conn = sqlite3.connect(db_path, isolation_level=None)
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(SCHEMA)
            # Replace only this event snapshot; legacy tables and any other
            # event rows are untouched.
            conn.execute(
                "DELETE FROM {t} WHERE event_id = ?".format(t=TABLE), (EVENT_ID,)
            )
            conn.executemany(
                "INSERT INTO {t} (event_id, event_beer_id, payload) "
                "VALUES (?, ?, ?)".format(t=TABLE),
                [
                    (
                        EVENT_ID,
                        rec["event_beer_id"],
                        json.dumps(rec, ensure_ascii=False, separators=(",", ":")),
                    )
                    for rec in records
                ],
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()

    emit({"ok": True, "event_id": EVENT_ID, "imported": len(records)})


# ---------------------------------------------------------------------------
# Normalisation / search
# ---------------------------------------------------------------------------

_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)
_WS_RE = re.compile(r"\s+")
_HASH_ID_RE = re.compile(r"^#(\d+)$")
_NUMERIC_RE = re.compile(r"^\d+$")


def normalize(text):
    """NFKC + diacritic/case/whitespace/punctuation normalisation.

    Punctuation becomes a space (digits and version tokens survive),
    combining marks are stripped, and whitespace collapses.
    """
    text = unicodedata.normalize("NFKD", str(text))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = unicodedata.normalize("NFKC", text).casefold()
    text = _PUNCT_RE.sub(" ", text).replace("_", " ")
    return _WS_RE.sub(" ", text).strip()


def record_haystack(rec):
    parts = [
        rec.get("name"),
        rec.get("name_zh"),
        rec.get("brewery"),
        rec.get("brewery_zh"),
    ]
    aliases = rec.get("aliases")
    if isinstance(aliases, list):
        parts.extend(a for a in aliases if isinstance(a, str))
    joined = " ".join(str(p) for p in parts if p)
    return normalize(joined)


def search(records, query):
    text = query.strip()
    hash_match = _HASH_ID_RE.match(text)
    if hash_match:
        target = int(hash_match.group(1))
        return [r for r in records if r.get("event_beer_id") == target]
    if _NUMERIC_RE.match(text):
        target = int(text)
        return [r for r in records if r.get("untappd_id") == target]

    normalized = normalize(text)
    if not normalized:
        return list(records)

    tokens = normalized.split(" ")
    matches = []
    for rec in records:
        hay = record_haystack(rec)
        token_set = set(hay.split(" "))
        ok = True
        for token in tokens:
            if token.isascii():
                # exact token: prevents v1 matching v10 and cross-field drift
                if token not in token_set:
                    ok = False
                    break
            elif token not in hay:
                # CJK phrases have no spaces: substring match
                ok = False
                break
        if ok:
            matches.append(rec)
    return matches


# ---------------------------------------------------------------------------
# Query (strictly read-only, no DDL)
# ---------------------------------------------------------------------------

def unavailable(reason, page):
    emit(
        {
            "event_id": EVENT_ID,
            "session": RED_SESSION,
            "available": False,
            "reason": reason,
            "total": 0,
            "page": page,
            "page_size": PAGE_SIZE,
            "results": [],
        }
    )


def cmd_query(db_path, query, page):
    if not is_pos_int(page) or page < 1:
        emit({"ok": False, "error": "page must be a positive integer"}, 1)

    if not os.path.isfile(db_path):
        unavailable("db_missing", page)

    uri = Path(db_path).resolve().as_uri() + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.OperationalError:
        unavailable("db_missing", page)
    try:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (TABLE,),
        ).fetchone()
        if not exists:
            unavailable("catalog_missing", page)
        rows = conn.execute(
            "SELECT event_beer_id, payload FROM {t} WHERE event_id = ? "
            "ORDER BY event_beer_id ASC".format(t=TABLE),
            (EVENT_ID,),
        ).fetchall()
    finally:
        conn.close()

    records = []
    for _, payload in rows:
        try:
            rec = json.loads(payload)
        except (TypeError, ValueError):
            continue
        sessions = rec.get("sessions")
        if isinstance(sessions, list) and RED_SESSION in sessions:
            records.append(rec)

    matched = search(records, query)
    total = len(matched)
    start = (page - 1) * PAGE_SIZE
    emit(
        {
            "event_id": EVENT_ID,
            "session": RED_SESSION,
            "available": True,
            "total": total,
            "page": page,
            "page_size": PAGE_SIZE,
            "results": matched[start : start + PAGE_SIZE],
        }
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description="MBCB catalog import/query CLI")
    parser.add_argument("--db", required=True, help="path to SQLite database")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--import", dest="import_path", help="atomically import JSON array")
    group.add_argument("--query", help="search string (#id / numeric untappd / text)")
    parser.add_argument("--page", type=int, default=1, help="1-based page (size 20)")
    args = parser.parse_args(argv)

    try:
        if args.import_path:
            cmd_import(args.db, args.import_path)
        else:
            cmd_query(args.db, args.query, args.page)
    except BatchError as exc:
        emit({"ok": False, "error": str(exc)}, 1)
    except sqlite3.Error as exc:
        print("sqlite error: %r" % (exc,), file=sys.stderr)
        emit({"ok": False, "error": "database error"}, 1)
    except Exception as exc:  # never leak internals on stdout
        print("unexpected error: %r" % (exc,), file=sys.stderr)
        emit({"ok": False, "error": "internal error"}, 1)


if __name__ == "__main__":
    main()
