#!/usr/bin/env python3
"""
Extract diverse beers from beer.db for the crawler output.
Selects top-rated beers across all major style categories.
"""
import sqlite3
import json
import sys
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / ".beer-data" / "beer.db"

def extract(target_count=250):
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    
    results = []
    seen_names = set()
    
    # Priority 1: Untappd cache (highest quality data)
    untappd_rows = con.execute(
        """SELECT id, name, brewery, style, abv, rating, ratings_count, 
                  untappd_url, country, label_image
           FROM untappd_cache 
           ORDER BY CAST(ratings_count AS INTEGER) DESC"""
    ).fetchall()
    
    for r in untappd_rows:
        key = r['name'].lower().strip()
        if key not in seen_names:
            seen_names.add(key)
            results.append({
                'beerName': r['name'],
                'breweryName': r['brewery'] or '',
                'style': r['style'] or '',
                'abv': round(r['abv'], 1) if r['abv'] else 0,
                'ibu': None,
                'hops': [],
                'untappdId': r['id'],
                'untappdScore': round(r['rating'], 3) if r['rating'] else None,
                'untappdRatingCount': int(r['ratings_count']) if r['ratings_count'] else None,
                'untappdUrl': r['untappd_url'] or None,
                'breweryCountry': r['country'] or None,
                'labelImage': r['label_image'] or None,
                'source': 'untappd',
                'verified': False,
                'confidence': 0.85,
                'crawledAt': None,
            })
            if len(results) >= target_count:
                break
    
    if len(results) >= target_count:
        con.close()
        return results
    
    # Priority 2: RateBeer beers by style diversity
    styles = con.execute(
        "SELECT style, COUNT(*) as cnt FROM beers GROUP BY style HAVING cnt > 10 ORDER BY cnt DESC"
    ).fetchall()
    
    for style_row in styles:
        if len(results) >= target_count:
            break
        style_name = style_row['style']
        
        beers = con.execute(
            """SELECT name, brewery, style, abv, rating, ratings_count
               FROM beers 
               WHERE style = ? AND name IS NOT NULL
               ORDER BY CAST(ratings_count AS INTEGER) DESC
               LIMIT 5""",
            (style_name,)
        ).fetchall()
        
        for b in beers:
            key = b['name'].lower().strip()
            if key not in seen_names:
                seen_names.add(key)
                results.append({
                    'beerName': b['name'],
                    'breweryName': b['brewery'] or '',
                    'style': b['style'] or style_name,
                    'abv': round(b['abv'], 1) if b['abv'] else 0,
                    'ibu': None,
                    'hops': [],
                    'untappdId': None,
                    'untappdScore': round(b['rating'], 2) if b['rating'] else None,
                    'untappdRatingCount': int(b['ratings_count']) if b['ratings_count'] else None,
                    'untappdUrl': None,
                    'breweryCountry': None,
                    'labelImage': None,
                    'source': 'ratebeer',
                    'verified': False,
                    'confidence': 0.75,
                    'crawledAt': None,
                })
    
    con.close()
    return results

if __name__ == '__main__':
    target = int(sys.argv[1]) if len(sys.argv) > 1 else 250
    results = extract(target)
    print(json.dumps(results, ensure_ascii=False, indent=2))
