#!/usr/bin/env node
/** CLI wrapper; Node 22.18+ supports TypeScript stripping automatically.
 * On earlier Node 22 versions pass --experimental-strip-types explicitly.
 */
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

  // Explicit opt-in keeps ordinary CLI invocations and smoke tests offline.
  const liveEnabled = process.env.BEER_LENS_LIVE === "1" && process.env.BEER_LENS_DRY_RUN !== "1";

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

  const { runLiveCrawl } = await import(pathToFileURL(path.join(ROOT, "lib", "crawler", "live-runner.ts")).href);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    const result = await runLiveCrawl({ args, signal: controller.signal, log: line => process.stderr.write(line + "\n") });
    process.exitCode = result.interrupted ? 130 : result.failed > 0 ? 1 : 0;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

main().catch((err) => {
  process.stderr.write(`[beer-lens-crawl] fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
