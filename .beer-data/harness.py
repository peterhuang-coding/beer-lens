#!/usr/bin/env python3
"""
Beer Lens Data Harness — 双通道数据采集与缓存管理

通道 1 (实时): query → cache hit? → return : WebSearch → verify → cache → return
通道 2 (定时): daily cron → batch search popular beers → verify → cache

Usage:
  python3 harness.py query "Heady Topper"       # 查缓存，未命中返回 miss
  python3 harness.py cache '<json>'              # 写入验证过的数据
  python3 harness.py stats                       # 缓存统计
  python3 harness.py warm-list [--limit 20]      # 输出待预热的啤酒列表
  python3 harness.py stale [--days 30]           # 列出过期缓存条目
  python3 harness.py health                      # Harness 健康检查
"""

import sqlite3
import json
import sys
import os
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path

DB_PATH = Path(__file__).parent / "beer.db"

# ── Top Chinese craft beers for cache warming ──
# These are high-priority beers that should always be cached.
# The warm-list is used by the daily cron to know what to search for.
WARM_LIST = [
    # Top-rated Chinese craft beers (by Untappd/B-A score)
    ("Burning HDHC", "Crazy Bear Industry"),
    ("Hop Roulade", "YE Brewing"),
    ("Lager De Blanc", "FEVER Ales"),
    ("Sleep", "HopFan"),
    ("Flying Fist IPA", "Jing-A Brewing Co."),
    ("Workers Pale Ale", "Jing-A Brewing Co."),
    ("Airpocalypse", "Jing-A Brewing Co."),
    ("Jump East Lake IPA", "NO.18 BREWING"),
    ("Film Camera", "NO.18 BREWING"),
    ("Monkey Fist IPA", "Slow Boat Brewery"),
    ("Hazy Dream", "Slow Boat Brewery"),
    ("Baby IPA", "Master Gao"),
    ("Jasmine Tea Lager", "Master Gao"),
    ("Panda King IPA", "Master Gao"),
    ("Imperial Sea Salt Gose", "NBeer"),
    ("No Criticism", "Shi Ba Brewing"),
    ("Demon Tamer IPA", "Dao Brew"),
    ("TKO IPA", "Boxing Cat Brewery"),
    ("Honey Ale", "Great Leap Brewing"),
    ("Make A Toast Sea Salt Gose", "Mahanine Brewing"),
    # International benchmarks
    ("Pliny The Elder", "Russian River Brewing Company"),
    ("Pliny The Younger", "Russian River Brewing Company"),
    ("Heady Topper", "The Alchemist"),
    ("Focal Banger", "The Alchemist"),
    ("King Sue", "Toppling Goliath Brewing Co."),
    ("Pseudo Sue", "Toppling Goliath Brewing Co."),
    ("Zombie Dust", "3 Floyds Brewing Co."),
    ("Julius", "Tree House Brewing Company"),
    ("Dinner", "Maine Beer Company"),
    ("Heady Topper", "The Alchemist"),
]

def _connect():
    if not DB_PATH.exists():
        return None
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    return con

def _ensure_tables(con):
    """Ensure all harness tables exist."""
    con.execute("""
        CREATE TABLE IF NOT EXISTS beer_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            chinese_name TEXT,
            brewery TEXT NOT NULL,
            chinese_brewery TEXT,
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
            last_accessed_at TEXT,
            access_count INTEGER DEFAULT 0,
            UNIQUE(name, brewery)
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS harness_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation TEXT NOT NULL,
            target TEXT,
            status TEXT,
            detail TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)

# ── Query ────────────────────────────────────────────────────────

def query_cache(name: str, brewery: str = None) -> dict:
    """Check if a beer exists in cache. Returns cached data or miss."""
    con = _connect()
    if not con:
        return {"hit": False, "error": "DB not found"}

    _ensure_tables(con)

    q = name.strip()
    rows = None

    # Exact match
    if brewery:
        rows = con.execute(
            "SELECT * FROM beer_cache WHERE LOWER(name) = ? AND LOWER(brewery) = ?",
            (q.lower(), brewery.lower())
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT * FROM beer_cache WHERE LOWER(name) = ? OR LOWER(chinese_name) = ?",
            (q.lower(), q.lower())
        ).fetchall()

    if rows:
        row = rows[0]
        # Update access stats
        con.execute(
            "UPDATE beer_cache SET last_accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?",
            (row['id'],)
        )
        con.commit()

        result = dict(row)
        result['hit'] = True
        result['cached_at'] = result.get('created_at')
        con.close()
        return result

    # Fuzzy match
    rows = con.execute(
        "SELECT * FROM beer_cache WHERE LOWER(name) LIKE ? OR LOWER(chinese_name) LIKE ? LIMIT 1",
        (f"%{q.lower()}%", f"%{q.lower()}%")
    ).fetchall()

    if rows:
        row = rows[0]
        con.execute(
            "UPDATE beer_cache SET last_accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?",
            (row['id'],)
        )
        con.commit()
        result = dict(row)
        result['hit'] = True
        result['match_type'] = 'fuzzy'
        con.close()
        return result

    con.close()
    return {"hit": False, "query": name}

# ── Write ─────────────────────────────────────────────────────────

def cache_beer(data: dict) -> dict:
    """Write a verified beer entry to cache."""
    con = _connect()
    if not con:
        return {"ok": False, "error": "DB not found"}

    _ensure_tables(con)

    name = data.get('name', '').strip()
    brewery = data.get('brewery', '').strip()
    if not name or not brewery:
        return {"ok": False, "error": "name and brewery required"}

    try:
        con.execute("""
            INSERT OR REPLACE INTO beer_cache
            (name, chinese_name, brewery, chinese_brewery, style, abv, rating,
             ratings_count, ibu, source_url, source_platform, verified, verified_at,
             last_accessed_at, access_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                COALESCE((SELECT access_count FROM beer_cache WHERE name=? AND brewery=?), 0))
        """, (
            name,
            data.get('chinese_name'),
            brewery,
            data.get('chinese_brewery'),
            data.get('style'),
            data.get('abv'),
            data.get('rating'),
            data.get('ratings_count', 0),
            data.get('ibu'),
            data.get('source_url'),
            data.get('source_platform', 'websearch'),
            1 if data.get('verified') else 0,
            datetime.now(timezone.utc).isoformat() if data.get('verified') else None,
            datetime.now(timezone.utc).isoformat(),
            name, brewery
        ))

        # Log
        con.execute(
            "INSERT INTO harness_log (operation, target, status, detail) VALUES (?, ?, ?, ?)",
            ('cache_write', f"{name} | {brewery}", 'ok', json.dumps({k: data.get(k) for k in ['rating', 'abv', 'source_platform']}))
        )
        con.commit()
        con.close()
        return {"ok": True, "name": name, "brewery": brewery}
    except Exception as e:
        con.close()
        return {"ok": False, "error": str(e)}

# ── Cache warming ─────────────────────────────────────────────────

def get_warm_list(limit: int = 20) -> list[dict]:
    """Return list of beers that should be pre-cached.
    Priority: WARM_LIST entries not yet in cache, sorted by priority."""
    con = _connect()
    if not con:
        return [{"name": n, "brewery": b, "priority": "warm_list"} for n, b in WARM_LIST[:limit]]

    _ensure_tables(con)

    # Find which warm-list beers are NOT in cache
    missing = []
    for name, brewery in WARM_LIST:
        row = con.execute(
            "SELECT id FROM beer_cache WHERE LOWER(name) = ? AND LOWER(brewery) = ?",
            (name.lower(), brewery.lower())
        ).fetchone()
        if not row:
            missing.append({"name": name, "brewery": brewery, "priority": "warm_list"})

    con.close()

    # If warm list is fully cached, suggest top uncached by rating from RateBeer
    if not missing:
        con2 = _connect()
        if con2:
            top = con2.execute("""
                SELECT DISTINCT b.name, b.brewery FROM beers b
                WHERE b.rating >= 4.0 AND b.ratings_count >= 100
                AND NOT EXISTS (SELECT 1 FROM beer_cache bc WHERE LOWER(bc.name) = LOWER(b.name) AND LOWER(bc.brewery) = LOWER(b.brewery))
                ORDER BY b.rating DESC LIMIT ?
            """, (limit,)).fetchall()
            con2.close()
            missing = [{"name": r['name'], "brewery": r['brewery'], "priority": "high_rated"} for r in top]

    return missing[:limit]

def get_stale_entries(days: int = 30) -> list[dict]:
    """Return cache entries older than `days` that should be refreshed."""
    con = _connect()
    if not con:
        return []

    _ensure_tables(con)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

    rows = con.execute(
        "SELECT name, brewery, rating, ratings_count, created_at, verified_at FROM beer_cache WHERE created_at < ? ORDER BY created_at ASC",
        (cutoff,)
    ).fetchall()
    con.close()

    return [dict(r) for r in rows]

# ── Stats & Health ────────────────────────────────────────────────

def get_stats() -> dict:
    """Harness statistics."""
    con = _connect()
    if not con:
        return {"error": "DB not found"}

    _ensure_tables(con)

    total = con.execute("SELECT COUNT(*) FROM beer_cache").fetchone()[0]
    verified = con.execute("SELECT COUNT(*) FROM beer_cache WHERE verified = 1").fetchone()[0]
    total_accesses = con.execute("SELECT COALESCE(SUM(access_count), 0) FROM beer_cache").fetchone()[0]

    # Most accessed
    top = con.execute(
        "SELECT name, brewery, rating, access_count FROM beer_cache ORDER BY access_count DESC LIMIT 5"
    ).fetchall()

    # Recent cache writes
    recent = con.execute(
        "SELECT COUNT(*) FROM beer_cache WHERE created_at > datetime('now', '-24 hours')"
    ).fetchone()[0]

    # Warm list coverage
    warm_total = len(WARM_LIST)
    warm_cached = 0
    for name, brewery in WARM_LIST:
        row = con.execute(
            "SELECT id FROM beer_cache WHERE LOWER(name) = ? AND LOWER(brewery) = ?",
            (name.lower(), brewery.lower())
        ).fetchone()
        if row:
            warm_cached += 1

    # Recent operations
    ops = con.execute(
        "SELECT operation, target, status, created_at FROM harness_log ORDER BY id DESC LIMIT 10"
    ).fetchall()

    # RateBeer stats
    rb_total = con.execute("SELECT COUNT(*) FROM beers").fetchone()[0]

    con.close()

    return {
        "beer_cache": {
            "total": total,
            "verified": verified,
            "unverified": total - verified,
            "last_24h": recent,
            "total_accesses": total_accesses,
        },
        "warm_list_coverage": f"{warm_cached}/{warm_total}",
        "ratebeer_backup": rb_total,
        "top_accessed": [dict(r) for r in top],
        "recent_operations": [dict(r) for r in ops],
    }

def health_check() -> dict:
    """Quick health check."""
    con = _connect()
    if not con:
        return {"healthy": False, "error": "DB not found"}

    _ensure_tables(con)
    cache_count = con.execute("SELECT COUNT(*) FROM beer_cache").fetchone()[0]
    verified_count = con.execute("SELECT COUNT(*) FROM beer_cache WHERE verified = 1").fetchone()[0]
    log_count = con.execute("SELECT COUNT(*) FROM harness_log").fetchone()[0]
    con.close()

    return {
        "healthy": True,
        "cache_entries": cache_count,
        "verified_entries": verified_count,
        "log_entries": log_count,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

# ── Main ──────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]

    if not args:
        print(json.dumps({"error": "Usage: harness.py <query|cache|stats|warm-list|stale|health>"}, ensure_ascii=False))
        sys.exit(1)

    cmd = args[0]

    if cmd == 'query':
        name = args[1] if len(args) > 1 else ""
        brewery = args[2] if len(args) > 2 else None
        result = query_cache(name, brewery)
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif cmd == 'cache':
        if len(args) < 2:
            print(json.dumps({"error": "cache requires JSON data"}, ensure_ascii=False))
            sys.exit(1)
        data = json.loads(args[1])
        result = cache_beer(data)
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif cmd == 'warm-list':
        limit = int(args[2]) if len(args) > 2 and args[1] == '--limit' else 20
        result = get_warm_list(limit)
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif cmd == 'stale':
        days = int(args[2]) if len(args) > 2 and args[1] == '--days' else 30
        result = get_stale_entries(days)
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif cmd == 'stats':
        result = get_stats()
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif cmd == 'health':
        result = health_check()
        print(json.dumps(result, ensure_ascii=False, indent=2))

    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}, ensure_ascii=False))
        sys.exit(1)

if __name__ == '__main__':
    main()
