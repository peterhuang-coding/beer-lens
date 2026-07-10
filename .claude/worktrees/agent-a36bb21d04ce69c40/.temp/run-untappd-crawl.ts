import { crawlUntappd } from "../lib/beer-agent/beer-db/crawlers/untappd";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

async function main() {
  const limit = parseInt(process.argv[2] || "250", 10);
  const proxy = "http://127.0.0.1:7897";

  console.log(`[run] starting crawl: limit=${limit}, proxy=${proxy}`);

  const result = await crawlUntappd({
    limit,
    proxy,
  });

  console.log(`[run] crawl done: ${result.beers.length} beers, ${result.pagesCrawled} pages, ${result.errors.length} errors`);

  if (result.beers.length === 0) {
    console.log("[run] no beers crawled. Errors:");
    for (const e of result.errors) console.log(`  - ${e}`);
    return;
  }

  // Print sample
  console.log("\n--- Sample (first 5) ---");
  for (const b of result.beers.slice(0, 5)) {
    console.log(`  ${b.name} | ${b.brewery} | ${b.style} | ${b.rating} | ${b.ratings_count}`);
  }

  // Write to untappd_cache via Python
  const dataPath = path.join(process.cwd(), ".temp", "untappd-import.json");
  await mkdir(path.dirname(dataPath), { recursive: true });
  await writeFile(dataPath, JSON.stringify(result.beers), "utf8");

  const script = `
import sqlite3, json, sys, time

with open(sys.argv[1]) as f:
    beers = json.load(f)

con = sqlite3.connect('.beer-data/beer.db')
cur = con.cursor()

added = 0
updated = 0
skipped = 0

for b in beers:
    beer_id = f"untappd_{int(time.time())}_{added}_{updated}"
    # Check if exists
    existing = cur.execute(
        'SELECT id FROM untappd_cache WHERE LOWER(name) = ? AND LOWER(brewery) = ?',
        (b['name'].lower(), (b.get('brewery') or '').lower())
    ).fetchone()

    if existing:
        cur.execute(
            '''UPDATE untappd_cache SET
               rating = ?, ratings_count = ?, style = ?, abv = ?,
               country = ?, untappd_url = ?, label_image = ?, updated_at = ?
               WHERE id = ?''',
            (b.get('rating', 0), b.get('ratings_count', 0),
             b.get('style', 'Unknown'), b.get('abv', 0),
             b.get('country', ''), b.get('untappd_url', ''),
             b.get('label_image', ''), int(time.time()), existing[0]))
        updated += 1
    else:
        cur.execute(
            '''INSERT INTO untappd_cache
               (id, name, brewery, style, abv, rating, ratings_count,
                country, untappd_url, label_image, source, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'untappd', ?)''',
            (beer_id, b['name'], b.get('brewery', ''), b.get('style', 'Unknown'),
             b.get('abv', 0), b.get('rating', 0), b.get('ratings_count', 0),
             b.get('country', ''), b.get('untappd_url', ''),
             b.get('label_image', ''), int(time.time())))
        added += 1

con.commit()

total = cur.execute('SELECT COUNT(*) FROM untappd_cache').fetchone()[0]
con.close()
print(json.dumps({"added": added, "updated": updated, "skipped": skipped, "total": total}))
`;

  const { stdout } = await execFileAsync("python3", ["-c", script, dataPath], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  console.log("\n[run] DB write result:", stdout.trim());
}

main().catch(err => {
  console.error("[run] fatal:", err);
  process.exit(1);
});
