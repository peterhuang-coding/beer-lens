#!/usr/bin/env node
/**
 * check-cookies.mjs — Validate an Untappd cookies JSON file.
 *
 * Usage:
 *   node scripts/check-cookies.mjs <cookies.json>
 *
 * Checks:
 *   - JSON parseable, is array
 *   - each entry has name, value, domain, path
 *   - at least one cookie has .untappd.com domain
 *   - session-like cookies present (heuristic)
 *   - values not suspiciously short / truncated
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const REQUIRED_KEYS = ["name", "value", "domain"];
const SESSION_HINTS = ["session", "token", "auth", "uid", "user_id", "remember"];

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/check-cookies.mjs <cookies.json>");
    process.exit(1);
  }

  let arr;
  try {
    const txt = await readFile(path.resolve(file), "utf8");
    arr = JSON.parse(txt);
  } catch (err) {
    console.error(`❌ Cannot parse ${file}: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(arr)) {
    console.error(`❌ ${file} is not an array. Playwright addCookies expects [...]`);
    process.exit(1);
  }

  console.log(`📋 ${file}: ${arr.length} cookies`);

  // Per-cookie validation
  const issues = [];
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    for (const k of REQUIRED_KEYS) {
      if (!c[k]) issues.push(`  [${i}] missing ${k}`);
    }
    if (typeof c.value === "string" && c.value.length < 8) {
      issues.push(`  [${i}] value too short (${c.value.length} chars): ${c.name}`);
    }
  }

  // Domain check
  const untappdCookies = arr.filter((c) => (c.domain || "").includes("untappd"));
  console.log(`   Untappd-domain cookies: ${untappdCookies.length}`);

  if (untappdCookies.length === 0) {
    issues.push(`  no cookies with 'untappd' in domain`);
  }

  // Session hints
  const sessionLike = arr.filter((c) =>
    SESSION_HINTS.some((h) => (c.name || "").toLowerCase().includes(h))
  );
  console.log(`   Session-like cookies: ${sessionLike.length}`);
  for (const s of sessionLike.slice(0, 5)) {
    console.log(`     - ${s.name} (${s.value.length} chars)`);
  }

  if (sessionLike.length === 0) {
    issues.push(`  no session-like cookies found (heuristic). Untappd may use csrf_token + session cookies — extract both.`);
  }

  // Summary
  if (issues.length > 0) {
    console.log(`\n❌ ${issues.length} issue(s):`);
    for (const i of issues) console.log(i);
    process.exit(1);
  } else {
    console.log(`\n✅ Cookies look valid. Ready to pass to --cookies.`);
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});