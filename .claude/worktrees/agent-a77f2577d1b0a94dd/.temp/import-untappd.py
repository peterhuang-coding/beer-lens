#!/usr/bin/env python3
"""Import Untappd top-rated beers into the untappd_cache table."""

import json
import sqlite3
import re
import os
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(__file__), '..', '.beer-data', 'beer.db')
JSON_PATH = os.path.join(os.path.dirname(__file__), 'untappd-beers-v2.json')

def extract_beer_id(untappd_url):
    """Extract the numeric beer ID from the Untappd URL."""
    # URL format: https://untappd.com/b/slug/123456
    match = re.search(r'/b/[^/]+/(\d+)$', untappd_url)
    if match:
        return match.group(1)
    # Fallback: last numeric segment
    match = re.search(r'(\d+)$', untappd_url)
    if match:
        return match.group(1)
    return None

def main():
    # Load beers from JSON
    with open(JSON_PATH, 'r', encoding='utf-8') as f:
        beers = json.load(f)
    
    print(f"Loaded {len(beers)} beers from JSON")
    
    # Connect to database
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Check current count
    cursor.execute("SELECT COUNT(*) FROM untappd_cache")
    before_count = cursor.fetchone()[0]
    print(f"untappd_cache before: {before_count} rows")
    
    # Prepare upsert
    now = datetime.now(timezone.utc).isoformat()
    inserted = 0
    updated = 0
    skipped = 0
    
    for beer in beers:
        beer_id = extract_beer_id(beer.get('untappd_url', ''))
        if not beer_id:
            print(f"  SKIP (no ID): {beer.get('name', '?')}")
            skipped += 1
            continue
        
        name = beer.get('name', '')
        brewery = beer.get('brewery', '')
        style = beer.get('style', '')
        abv = beer.get('abv', 0)
        rating = beer.get('rating', 0)
        ratings_count = beer.get('ratings_count', 0)
        country = beer.get('country', '')
        untappd_url = beer.get('untappd_url', '')
        label_image = beer.get('label_image', '')
        source = 'untappd_top_rated'
        
        # Upsert (INSERT OR REPLACE)
        cursor.execute("""
            INSERT INTO untappd_cache (id, name, brewery, style, abv, rating, ratings_count, country, untappd_url, label_image, source, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                brewery=excluded.brewery,
                style=excluded.style,
                abv=excluded.abv,
                rating=excluded.rating,
                ratings_count=excluded.ratings_count,
                country=excluded.country,
                untappd_url=excluded.untappd_url,
                label_image=excluded.label_image,
                source=excluded.source,
                updated_at=excluded.updated_at
        """, (beer_id, name, brewery, style, abv, rating, ratings_count, country, untappd_url, label_image, source, now))
        
        if cursor.rowcount == 1:
            inserted += 1
        else:
            updated += 1
    
    conn.commit()
    
    # Check after count
    cursor.execute("SELECT COUNT(*) FROM untappd_cache")
    after_count = cursor.fetchone()[0]
    
    print(f"\nResults:")
    print(f"  Inserted: {inserted}")
    print(f"  Updated:  {updated}")
    print(f"  Skipped:  {skipped}")
    print(f"  untappd_cache after: {after_count} rows (was {before_count})")
    
    # Show some sample data
    cursor.execute("SELECT id, name, brewery, style, rating, ratings_count FROM untappd_cache ORDER BY rating DESC LIMIT 10")
    print(f"\nTop 10 by rating:")
    for row in cursor.fetchall():
        print(f"  [{row[0]}] {row[1]} - {row[2]} | {row[3]} | {row[4]} ({row[5]} ratings)")
    
    # Style distribution
    cursor.execute("SELECT style, COUNT(*) as cnt FROM untappd_cache GROUP BY style ORDER BY cnt DESC LIMIT 10")
    print(f"\nTop 10 styles:")
    for row in cursor.fetchall():
        print(f"  {row[0]}: {row[1]}")
    
    conn.close()

if __name__ == '__main__':
    main()
