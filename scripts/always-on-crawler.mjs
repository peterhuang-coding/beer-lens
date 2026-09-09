#!/usr/bin/env node
/** Generate an explicit target round. Network collection is a separate action. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ROOT, readBeers, readJson } from "./project-data.mjs";
import {
  dedupeAndMerge,
  filterByBrewery,
  filterByCountry,
  shapeOutput,
} from "./always-on-crawler-lib.mjs";

function parseArgs(argv) {
  const args = {
    limit: 30,
    round: null,
    breweries: [],
    countries: ["China"],
    targets: null,
    output: "data/round-targets.json",
    print: false,
    dryRun: false,
    gapOnly: false,
  };
  const values = {
    "--limit": "limit",
    "-l": "limit",
    "--round": "round",
    "-r": "round",
    "--breweries": "breweries",
    "-b": "breweries",
    "--countries": "countries",
    "-c": "countries",
    "--targets": "targets",
    "-t": "targets",
    "--output": "output",
    "-o": "output",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i],
      key = values[arg];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (key) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-"))
        throw new Error(`Missing value for ${arg}`);
      if (key === "limit" || key === "round") {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
          throw new Error(`${key} must be a non-negative integer`);
        args[key] = Number(value);
      } else if (key === "breweries" || key === "countries")
        args[key] = value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      else args[key] = value;
    } else if (arg === "--print" || arg === "-p") args.print = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--gap-only") args.gapOnly = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}
function targetsFrom(raw, label) {
  const items = Array.isArray(raw) ? raw : (raw?.targets ?? raw?.beers);
  if (
    !Array.isArray(items) ||
    items.some(
      (t) =>
        !t ||
        typeof t.name !== "string" ||
        !t.name.trim() ||
        typeof t.brewery !== "string" ||
        !t.brewery.trim(),
    )
  )
    throw new Error(
      `Invalid targets in ${label}: name and brewery are required`,
    );
  return items;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: npm run crawl:round -- [--round N] [--limit N] [--breweries CSV] [--countries CSV] [--targets PATH] [--output PATH] [--gap-only] [--print] [--dry-run]\nBuild a target list; this does not crawl sites. Optional data/warm-list-gaps.json supplies priority gaps. Relative input/output paths use the current directory.",
    );
    return;
  }
  const gaps = targetsFrom(
    await readJson("data/warm-list-gaps.json", []),
    "warm-list-gaps",
  ).map((t) => ({ ...t, priority: "p0_gap" }));
  const user = args.targets
    ? targetsFrom(
        JSON.parse(await readFile(path.resolve(args.targets), "utf8")),
        args.targets,
      ).map((t) => ({ ...t, priority: "p1_user" }))
    : [];
  const seeds = args.gapOnly
    ? []
    : filterByCountry(
        filterByBrewery(await readBeers(), args.breweries),
        args.countries,
      ).map((t) => ({ ...t, priority: "p2_seed" }));
  const targets = dedupeAndMerge({ gaps, user, seeds }, args.limit);
  const output = shapeOutput({
    ...args,
    filters: args,
    gaps,
    user,
    seeds,
    targets,
  });
  if (args.print || args.dryRun)
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  else {
    const file = path.resolve(args.output);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(output, null, 2) + "\n");
    console.log(`Wrote ${targets.length} targets to ${file}`);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
