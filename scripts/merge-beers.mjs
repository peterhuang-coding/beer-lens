#!/usr/bin/env node
/**
 * Merge new beer data into chinese-craft-beers.json, with dedup by name+brewery.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const EXISTING = join(ROOT, "data", "chinese-craft-beers.json");
const NEW_DATA = join(ROOT, "data", "new-beers-2024-awards.json");
const OUTPUT = join(ROOT, "data", "chinese-craft-beers.json"); // overwrite

const existing = JSON.parse(readFileSync(EXISTING, "utf8"));
const incoming = JSON.parse(readFileSync(NEW_DATA, "utf8"));

const seen = new Set();
const merged = [];

// First pass: existing data (keep all)
for (const b of existing) {
  const key = `${b.name.toLowerCase().trim()}|${b.brewery.toLowerCase().trim()}`;
  if (!seen.has(key)) {
    seen.add(key);
    merged.push(b);
  }
}

// Second pass: new data (skip duplicates)
let added = 0;
let skipped = 0;
for (const b of incoming) {
  const key = `${b.name.toLowerCase().trim()}|${b.brewery.toLowerCase().trim()}`;
  if (!seen.has(key)) {
    seen.add(key);
    merged.push(b);
    added++;
  } else {
    skipped++;
  }
}

// Sort by rating desc
merged.sort((a, b) => (b.rating || 0) - (a.rating || 0));

writeFileSync(OUTPUT, JSON.stringify(merged, null, 2) + "\n");

const styles = new Set(merged.map(b => b.style));
const breweries = new Set(merged.map(b => b.brewery));
console.log(`✅ Merged: ${existing.length} existing + ${added} new = ${merged.length} total`);
console.log(`   Skipped duplicates: ${skipped}`);
console.log(`   Breweries: ${breweries.size} | Styles: ${styles.size}`);
console.log(`   Output: ${OUTPUT}`);
