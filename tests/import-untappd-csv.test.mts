import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "import-untappd-csv.mjs");
const FIXTURE = path.join(
  ROOT,
  "tests",
  "fixtures",
  "untappd-import-sample.csv",
);

// Dynamic import so we exercise the same module that the CLI runs.
const importMod = () => import(pathToFileURL(SCRIPT).href);

// ── (a) parse single CSV row → correct BeerRecord ────────────────────────

test("csvRowToBeerRecord maps a parsed row to a schema-correct BeerRecord", async () => {
  const { parseCsvLine, csvRowToBeerRecord } = await importMod();
  const fields = parseCsvLine(
    "4957193,Pure Draft Dusseldorf Altbier,Y.Market Brewing,Altbier - Traditional,Japan,5,3.695,172,/b/y-market-brewing-pure-draft-dusseldorf-altbier/4957193,https://example.com/x.jpeg",
  );
  const row = {
    id: fields[0],
    name: fields[1],
    brewery: fields[2],
    style: fields[3],
    country: fields[4],
    abv: fields[5],
    rating: fields[6],
    ratings_count: fields[7],
    untappd_url: fields[8],
    label_image: fields[9],
  };
  const rec = csvRowToBeerRecord(row);

  assert.equal(rec.source, "untappd");
  assert.equal(rec.source_id, "4957193");
  assert.equal(rec.name, "Pure Draft Dusseldorf Altbier");
  assert.equal(rec.brewery_id, null);
  assert.equal(rec.style, "Altbier - Traditional");
  assert.equal(rec.abv, 5);
  assert.equal(rec.ibu, null);
  assert.equal(rec.rating, 3.695);
  assert.equal(rec.rating_count, 172);
  assert.equal(rec.description, null);
  assert.deepEqual(rec.labels, []);
  assert.deepEqual(rec.food_pairing, []);
  assert.deepEqual(rec.similar_ids, []);
  assert.equal(
    rec.url,
    "https://untappd.com/b/y-market-brewing-pure-draft-dusseldorf-altbier/4957193",
  );
  assert.match(rec.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
});

// ── (b) URL concatenation (relative /b/xxx → https://untappd.com/b/xxx) ──

test("url is concatenated with https://untappd.com prefix", async () => {
  const { csvRowToBeerRecord } = await importMod();
  const rec = csvRowToBeerRecord({
    id: "1",
    name: "x",
    brewery: "y",
    style: "z",
    country: "Japan",
    abv: "5",
    rating: "3.5",
    ratings_count: "10",
    untappd_url: "/b/example/1",
    label_image: "https://example.com/x.jpeg",
  });
  assert.equal(rec.url, "https://untappd.com/b/example/1");
});

// Absolute untappd_url is preserved as-is.
test("absolute URL is preserved", async () => {
  const { csvRowToBeerRecord } = await importMod();
  const rec = csvRowToBeerRecord({
    id: "1",
    name: "x",
    brewery: "y",
    style: "z",
    country: "Japan",
    abv: "5",
    rating: "3.5",
    ratings_count: "10",
    untappd_url: "https://other.example/b/1",
    label_image: "",
  });
  assert.equal(rec.url, "https://other.example/b/1");
});

// ── (c) rating_distribution bucket boundaries ─────────────────────────────

test("rating_distribution buckets edges: 0, 1, 2, 3, 3.5, 4, 4.5, 5", async () => {
  const { bucketFor } = await importMod();
  assert.equal(bucketFor(0), "0-1");
  assert.equal(bucketFor(0.5), "0-1");
  assert.equal(bucketFor(0.999), "0-1");
  assert.equal(bucketFor(1), "1-2");
  assert.equal(bucketFor(1.5), "1-2");
  assert.equal(bucketFor(2), "2-3");
  assert.equal(bucketFor(3), "3-3.5");
  assert.equal(bucketFor(3.4999), "3-3.5");
  assert.equal(bucketFor(3.5), "3.5-4");
  assert.equal(bucketFor(4), "4-4.5");
  assert.equal(bucketFor(4.5), "4.5-5");
  assert.equal(bucketFor(5), "4.5-5");
});

// ── (d) abv_distribution null tolerance ───────────────────────────────────

test("abv_stats tolerates null / missing values (only numeric ABV feeds the sorted array)", async () => {
  const { csvRowToBeerRecord } = await importMod();
  // Missing ABV (empty string) → null, no throw.
  const rec = csvRowToBeerRecord({
    id: "4",
    name: "x",
    brewery: "y",
    style: "z",
    country: "USA",
    abv: "",
    rating: "4.0",
    ratings_count: "10",
    untappd_url: "/b/x/4",
    label_image: "",
  });
  assert.equal(rec.abv, null);

  // Garbage ABV → null, no throw.
  const rec2 = csvRowToBeerRecord({
    id: "5",
    name: "x",
    brewery: "y",
    style: "z",
    country: "USA",
    abv: "n/a",
    rating: "4.0",
    ratings_count: "10",
    untappd_url: "/b/x/5",
    label_image: "",
  });
  assert.equal(rec2.abv, null);

  // Non-null numeric ABV → value preserved.
  const rec3 = csvRowToBeerRecord({
    id: "6",
    name: "x",
    brewery: "y",
    style: "z",
    country: "USA",
    abv: "8.5",
    rating: "4.0",
    ratings_count: "10",
    untappd_url: "/b/x/6",
    label_image: "",
  });
  assert.equal(rec3.abv, 8.5);
});

// ── (e) end-to-end: run import on fixture, verify JSONL + stats ──────────

test("end-to-end: run import on fixture, JSONL has 2 lines per record + stats are valid", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "beer-csv-"));
  const outJsonl = path.join(tmpDir, "out.jsonl");
  const outStats = path.join(tmpDir, "stats.json");

  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(
    "node",
    [
      SCRIPT,
      "--in",
      FIXTURE,
      "--out",
      outJsonl,
      "--stats",
      outStats,
    ],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, `import failed: ${res.stderr}`);

  // Fixture has 10 data rows (header + 10).
  const lines = (await fs.readFile(outJsonl, "utf8"))
    .split("\n")
    .filter(Boolean);
  assert.equal(lines.length, 20, "expected 10 records × 2 lines (rec + meta)");

  // Every odd-indexed line is a meta line with __meta:true.
  const rec0 = JSON.parse(lines[0]);
  const meta0 = JSON.parse(lines[1]);
  assert.equal(meta0.__meta, true);
  assert.equal(meta0.country, "Japan");
  assert.equal(rec0.source, "untappd");

  // Quoted CSV cell with embedded comma parsed correctly.
  const allRecs = lines
    .filter((_, i) => i % 2 === 0)
    .map((l) => JSON.parse(l));
  const quoted = allRecs.find((r) => r.source_id === "6");
  assert.ok(quoted, "record with id=6 (quoted CSV cell) must be present");
  assert.equal(quoted.name, "Quoted, Name With Comma");

  // Stats sanity: 10 rows, 8 distinct breweries.
  const stats = JSON.parse(await fs.readFile(outStats, "utf8"));
  assert.equal(stats.total_records, 10);
  assert.equal(stats.brewery_unique, 8);
  assert.ok(stats.by_country.length >= 1);
  // Country "Japan" should be the largest bucket (7 of 10 rows).
  assert.equal(stats.by_country[0].country, "Japan");
  assert.equal(stats.by_country[0].count, 7);
  // abv_distribution present + null-safe.
  assert.ok(stats.abv_distribution);
  // Style entries present (we have at least 6 distinct styles in fixture).
  assert.ok(stats.by_style_top_50.length >= 1);
  // generated_at is ISO.
  assert.match(stats.generated_at, /^\d{4}-\d{2}-\d{2}T/);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── (f) CSV parser handles escaped quotes + comma inside quotes ───────────

test("parseCsvLine handles quoted fields with embedded comma and escaped quote", async () => {
  const { parseCsvLine } = await importMod();
  const fields = parseCsvLine(
    '6,"Quoted, Name ""With Comma""",Quoted Brewery,Porter,UK,6,3.9,20,/b/q/6,https://example.com/q.jpeg',
  );
  assert.equal(fields.length, 10);
  assert.equal(fields[0], "6");
  assert.equal(fields[1], 'Quoted, Name "With Comma"');
  assert.equal(fields[2], "Quoted Brewery");
});