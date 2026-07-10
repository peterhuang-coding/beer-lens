#!/usr/bin/env python3
"""
Beer lookup — query local SQLite beer database.
Returns JSON. Callable from Node.js via child_process.

Usage:
  python3 lookup.py "Pseudo Sue"
  python3 lookup.py --batch "Pseudo Sue|King Sue|Green City"
  python3 lookup.py --stats
"""

import sqlite3
import json
import sys
import os
import re
from pathlib import Path

DB_PATH = Path(__file__).parent / "beer.db"


def _connect():
    if not DB_PATH.exists():
        return None
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    return con


def search_beer(query: str, limit: int = 5) -> list[dict]:
    """Search both Untappd cache (priority) and RateBeer database.
    Handles combined queries like 'BeerName Brewery'. """
    con = _connect()
    if not con:
        return []

    q = re.sub(r'\s+', ' ', query.strip().lower())
    results = []

    # Try progressively shorter queries: "beer name brewery" → "beer name" → "beer"
    for attempt_q in _expand_queries(q):
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

    total = con.execute("SELECT COUNT(*) FROM beers").fetchone()[0]
    breweries = con.execute("SELECT COUNT(DISTINCT brewery) FROM beers").fetchone()[0]
    styles = con.execute("SELECT COUNT(DISTINCT style) FROM beers").fetchone()[0]
    avg_rating = con.execute("SELECT AVG(rating) FROM beers").fetchone()[0]
    top_styles = [dict(r) for r in con.execute(
        "SELECT style, COUNT(*) as count, ROUND(AVG(rating),2) as avg_rating FROM beers GROUP BY style HAVING count >= 50 ORDER BY count DESC LIMIT 10"
    ).fetchall()]

    con.close()
    return {
        'total_beers': total,
        'total_breweries': breweries,
        'total_styles': styles,
        'avg_rating': round(avg_rating, 2),
        'top_styles': top_styles,
        'source': 'RateBeer Kaggle Dataset (1.58M reviews)'
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


def main():
    args = sys.argv[1:]

    if not args:
        print(json.dumps({"error": "Usage: lookup.py <beer_name> | --batch <name1|name2|...> | --stats"}))
        sys.exit(1)

    if args[0] == '--stats':
        result = get_stats()
    elif args[0] == '--batch':
        if len(args) < 2:
            print(json.dumps({"error": "--batch requires pipe-separated beer names"}))
            sys.exit(1)
        queries = [q.strip() for q in args[1].split('|') if q.strip()]
        result = search_batch(queries)
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
