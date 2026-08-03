#!/usr/bin/env node
/**
 * bin/beer-lens-crawl.mjs
 *
 * CLI entrypoint. Loads lib/crawler/cli.ts via Node's --experimental-strip-types.
 * NOTE: invoked via `node --experimental-strip-types bin/beer-lens-crawl.mjs`
 * OR — when installed via `bin` — `node --experimental-strip-types` is implicit
 * because Node ≥ 22.6 loads .ts files. We use a .mjs wrapper so shebangs work
 * even when strip-types isn't enabled at the user level.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Resolve lib/crawler/cli.ts relative to this script. We import via dynamic
// import() so the rest of the CLI surface can stay in TypeScript.
const cliUrl = pathToFileURL(path.join(ROOT, "lib", "crawler", "cli.ts")).href;

function parseTopFlags(argv) {
  // The wrapper itself doesn't accept flags — it forwards everything.
  return argv;
}

async function main() {
  const argv = process.argv.slice(2);
  parseTopFlags(argv);

  let mod;
  try {
    mod = await import(cliUrl);
  } catch (err) {
    process.stderr.write(
      `[beer-lens-crawl] failed to load cli module: ${err.message}\n` +
        `Hint: re-run with \`node --experimental-strip-types bin/beer-lens-crawl.mjs\`\n`,
    );
    process.exit(2);
  }

  const { parseArgs, printHelp, runCrawl } = mod;

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`[beer-lens-crawl] ${err.message}\n\n`);
    printHelp(process.stderr.write.bind(process.stderr));
    process.exit(2);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // For real use, candidates / workers / drivers are wired in by the
  // integration shell. The CLI in isolation runs in dry-run mode by
  // default unless BEER_LENS_LIVE=1 is set (kept off to honour the
  // "no real network from CLI smoke" rule).
  const liveEnabled = process.env.BEER_LENS_LIVE === "1";

  if (args.dry_run || !liveEnabled) {
    const result = await runCrawl({
      args: { ...args, dry_run: true },
      log: (line) => process.stdout.write(line + "\n"),
    });
    if (result.errors.totals.http_4xx + result.errors.totals.http_5xx > 0) {
      process.exit(1);
    }
    process.exit(0);
  }

  // Live mode stub — real driver wiring lives in the integration worktree.
  process.stderr.write(
    "[beer-lens-crawl] live mode requires driver wiring from dev-integration.\n" +
      "Set BEER_LENS_DRY_RUN=1 or pass --dry-run to use the offline plan path.\n",
  );
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`[beer-lens-crawl] fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
