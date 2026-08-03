/**
 * lib/crawler/cli.ts
 *
 * CLI surface for the beer-lens crawler:
 *   parseArgs(argv)  — turns raw argv into a validated CliArgs object
 *   runCrawl(opts)   — orchestrates dry-run / live / resume with progress,
 *                      error aggregation, and signal handling
 *
 * The runner deliberately does NOT import real drivers / cookie pools / HTTP
 * modules from sibling agents (those live in their own worktrees). Instead it
 * talks to a small driver interface (CrawlDriver) and a generator callback
 * that the integration shell wires up. The CLI itself is fully testable
 * with stub drivers and zero real network calls.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  CliArgs,
  CrawlError,
  CrawlMode,
  CrawlOptions,
  CrawlState,
  Source,
} from "./contracts.ts";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_RETRY_BUDGET,
  MAX_CONCURRENCY,
} from "./contracts.ts";
import { ErrorAggregator } from "./error-aggregator.ts";
import { TtyProgressPrinter } from "./progress.ts";
import {
  installSignalHandler,
  readState,
  writeState,
} from "./signal.ts";

/* ------------------------------------------------------------------ */
/*  Argv parsing                                                     */
/* ------------------------------------------------------------------ */

const VALID_SOURCES: Source[] = ["untappd", "ratebeer"];
const VALID_TAGS = new Set(["china", "craft", "none"]);
const USAGE = `Usage: beer-lens-crawl --source <untappd|ratebeer> [options]

Options:
  --source <name>       Source: untappd | ratebeer (required unless --help)
  --concurrency <n>     Concurrent in-flight pages (default 2, hard cap 4)
  --dry-run             Print plan; make ZERO network calls
  --limit <n>           Stop after n processed records
  --tag <name>          Filter tag: china | craft
  --resume              Continue from data/crawler/<source>/.state.json
  --help                Show this help and exit
`;

export class CliArgError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CliArgError";
  }
}

export function parseArgs(argv: string[]): CliArgs {
  let source: Source | null = null;
  let concurrency = DEFAULT_CONCURRENCY;
  let dry_run = false;
  let limit: number | null = null;
  let tag: string | null = null;
  let resume = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const next = argv[i + 1];
    switch (tok) {
      case "--source": {
        if (!next || next.startsWith("--")) throw new CliArgError("--source requires a value");
        if (!VALID_SOURCES.includes(next as Source))
          throw new CliArgError(`--source must be one of: ${VALID_SOURCES.join(", ")}`);
        source = next as Source;
        i++;
        break;
      }
      case "--concurrency": {
        if (!next) throw new CliArgError("--concurrency requires a value");
        const n = Number(next);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1)
          throw new CliArgError("--concurrency must be a positive integer");
        concurrency = n;
        i++;
        break;
      }
      case "--limit": {
        if (!next) throw new CliArgError("--limit requires a value");
        const n = Number(next);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0)
          throw new CliArgError("--limit must be a non-negative integer");
        limit = n;
        i++;
        break;
      }
      case "--tag": {
        if (!next) throw new CliArgError("--tag requires a value");
        if (!VALID_TAGS.has(next))
          throw new CliArgError(`--tag must be one of: ${Array.from(VALID_TAGS).join(", ")}`);
        tag = next === "none" ? null : next;
        i++;
        break;
      }
      case "--dry-run":
        dry_run = true;
        break;
      case "--resume":
        resume = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new CliArgError(`unknown flag: ${tok}`);
    }
  }

  if (!help && !source)
    throw new CliArgError("--source is required (use --help for usage)");

  // Enforce hard cap at parse time so --concurrency 5 fails fast.
  assertConcurrency(concurrency);

  return {
    source: (source ?? "untappd") as Source,
    concurrency,
    dry_run,
    limit,
    tag,
    resume,
    help,
  };
}

export function printHelp(write: (s: string) => void = (s) => process.stdout.write(s)): void {
  write(USAGE);
}

/* ------------------------------------------------------------------ */
/*  Concurrency enforcement                                            */
/* ------------------------------------------------------------------ */

export function assertConcurrency(n: number): void {
  if (!Number.isInteger(n) || n < 1)
    throw new CliArgError(`--concurrency must be >= 1, got ${n}`);
  if (n > MAX_CONCURRENCY)
    throw new CliArgError(
      `--concurrency hard cap is ${MAX_CONCURRENCY} (got ${n}). ` +
        `Higher parallelism risks Untappd cookie-ban; lower the value.`,
    );
}

/* ------------------------------------------------------------------ */
/*  runCrawl — the orchestrator                                        */
/* ------------------------------------------------------------------ */

export interface RunCrawlOpts {
  args: CliArgs;
  outputDir?: string;
  candidateIds?: Iterable<string> | (() => Iterable<string>);
  worker?: (id: string, signal: AbortSignal) => Promise<"ok" | "skip" | { fail: CrawlError }>;
  sink?: (line: string) => void;
  driver?: { mode: "puppeteer" | "http" };
  signalHandle?: { abort: AbortSignal };
  printer?: TtyProgressPrinter;
  aggregator?: ErrorAggregator;
  log?: (line: string) => void;
  now?: () => number;
}

export interface RunCrawlResult {
  mode: CrawlMode;
  progress: {
    total: number;
    done: number;
    failed: number;
    skipped: number;
    eta_seconds: number | null;
  };
  errors: ReturnType<ErrorAggregator["snapshot"]>;
  stateWritten: string | null;
  dryRunPlan: string[];
}

function resolveCandidateIds(c: RunCrawlOpts["candidateIds"]): string[] {
  if (!c) return [];
  if (typeof c === "function") return Array.from(c());
  return Array.from(c);
}

export async function runCrawl(opts: RunCrawlOpts): Promise<RunCrawlResult> {
  const args = opts.args;
  assertConcurrency(args.concurrency);

  const log = opts.log ?? ((line: string) => console.log(line));
  const now = opts.now ?? (() => Date.now());

  const outputDir = opts.outputDir ?? path.join("data", "crawler", args.source);
  const stateFile = path.join(outputDir, ".state.json");

  // Resume: load checkpoint if present.
  let resumeState: CrawlState | null = null;
  if (args.resume) {
    resumeState = await readState(outputDir);
    if (resumeState) {
      log(`[crawler] resumed from ${stateFile} (processed=${resumeState.processed_ids.length})`);
    } else {
      log(`[crawler] --resume set but no prior state found; starting fresh`);
    }
  }

  const mode: CrawlMode = args.dry_run ? "dry-run" : "live";
  const printer = opts.printer ?? new TtyProgressPrinter();
  const aggregator = opts.aggregator ?? new ErrorAggregator();

  const candidates = resolveCandidateIds(opts.candidateIds);
  const total = args.limit != null ? Math.min(args.limit, candidates.length) : candidates.length;

  const planLines: string[] = [];
  planLines.push(`mode=${mode} source=${args.source} concurrency=${args.concurrency} total=${total}`);
  if (args.tag) planLines.push(`tag=${args.tag}`);
  if (args.limit != null) planLines.push(`limit=${args.limit}`);

  if (mode === "dry-run") {
    planLines.push("DRY RUN — no driver.run() will be invoked, no records will be written");
    for (const id of candidates.slice(0, Math.min(total, 10))) {
      planLines.push(`  plan: fetch ${args.source}/${id}`);
    }
    if (total > 10) planLines.push(`  … and ${total - 10} more`);

    const progress = {
      total,
      done: 0,
      failed: 0,
      skipped: 0,
      eta_seconds: 0,
    };
    printer.flush(progress);
    log(planLines.join("\n"));

    return {
      mode,
      progress,
      errors: aggregator.snapshot(),
      stateWritten: null,
      dryRunPlan: planLines,
    };
  }

  // Live mode — actually run a worker pool.
  const startedAt = new Date().toISOString();
  const processed: string[] = resumeState?.processed_ids.slice() ?? [];
  const failedIds: string[] = resumeState?.failed_ids.slice() ?? [];
  const seen = new Set(processed);

  let lastStateWritten: string | null = null;
  const writeCheckpoint = async (cursor: string | null): Promise<void> => {
    const st: CrawlState = {
      source: args.source,
      started_at: resumeState?.started_at ?? startedAt,
      updated_at: new Date().toISOString(),
      cursor,
      processed_ids: processed.slice(),
      failed_ids: failedIds.slice(),
      opts: {
        concurrency: args.concurrency,
        limit: args.limit,
        tag: args.tag,
      },
    };
    lastStateWritten = await writeState(outputDir, st);
  };

  // Install signal handler — only in real run mode, and only if we have a
  // real AbortController (tests inject a stub that doesn't kill the runner).
  const abortCtrl = new AbortController();
  const abortSignal: AbortSignal = opts.signalHandle ? opts.signalHandle.abort : abortCtrl.signal;
  if (!opts.signalHandle) {
    const installed = installSignalHandler({
      outputDir,
      stateProvider: () => ({
        source: args.source,
        started_at: resumeState?.started_at ?? startedAt,
        cursor: null,
        processed_ids: processed.slice(),
        failed_ids: failedIds.slice(),
        opts: {
          concurrency: args.concurrency,
          limit: args.limit,
          tag: args.tag,
        },
      }),
      onExit: () => {
        /* swallowed: signal handler exits with 130; runner returns normally. */
      },
    });
    // Hook the installed abort into the same controller we use for the pool.
    installed.abort.addEventListener("abort", () => {
      try { abortCtrl.abort(); } catch { /* already aborted */ }
    });
  }

  const pool: Array<Promise<void>> = [];
  let cursor: string | null = null;
  let processed_count = 0;
  let failed_count = 0;
  let skipped_count = 0;
  const startedAtMs = now();

  const queue = candidates.slice();
  let drained = false;
  const enqueueNext = (): void => {
    while (
      pool.length < args.concurrency &&
      queue.length > 0 &&
      (processed_count + failed_count + skipped_count) < total
    ) {
      const id = queue.shift()!;
      if (seen.has(id)) {
        skipped_count++;
        continue;
      }
      const worker = opts.worker ?? (async () => "ok" as const);
      const p = (async () => {
        const result = await worker(id, abortSignal);
        if (result === "ok") {
          processed.push(id);
          seen.add(id);
          processed_count++;
          const sink = opts.sink ?? ((line) => process.stdout.write(line + "\n"));
          sink(JSON.stringify({ source: args.source, source_id: id, ts: new Date().toISOString() }));
        } else if (result === "skip") {
          skipped_count++;
        } else {
          failed_count++;
          failedIds.push(id);
          aggregator.add({
            kind: result.fail.kind,
            url: result.fail.url,
            message: result.fail.message,
            status: result.fail.status,
            ts: new Date().toISOString(),
          });
        }
      })().finally(() => {
        const idx = pool.indexOf(p);
        if (idx >= 0) pool.splice(idx, 1);
        enqueueNext();
      });
      pool.push(p);
      cursor = id;
    }
    if (
      pool.length === 0 &&
      queue.length === 0 &&
      (processed_count + failed_count + skipped_count) >= total
    ) {
      drained = true;
    }
  };

  enqueueNext();

  // Tick progress while the pool drains.
  const tickHandle = setInterval(() => {
    const remaining = Math.max(0, total - processed_count - failed_count - skipped_count);
    const elapsedSec = Math.max(1, (now() - startedAtMs) / 1000);
    const etaSeconds = processed_count > 0 && remaining > 0
      ? Math.round(remaining / (processed_count / elapsedSec))
      : null;
    printer.tick({
      total,
      done: processed_count,
      failed: failed_count,
      skipped: skipped_count,
      eta_seconds: etaSeconds,
    });
  }, 50);

  // Wait until pool drains or signal aborts.
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (drained || pool.length === 0 || abortSignal.aborted) {
        clearInterval(check);
        resolve();
      }
    }, 25);
  });
  clearInterval(tickHandle);

  await writeCheckpoint(cursor);
  printer.flush({
    total,
    done: processed_count,
    failed: failed_count,
    skipped: skipped_count,
    eta_seconds: 0,
  });

  if (!opts.signalHandle) {
    const { uninstallSignalHandler } = await import("./signal.ts");
    uninstallSignalHandler();
  }

  return {
    mode,
    progress: {
      total,
      done: processed_count,
      failed: failed_count,
      skipped: skipped_count,
      eta_seconds: 0,
    },
    errors: aggregator.snapshot(),
    stateWritten: lastStateWritten,
    dryRunPlan: planLines,
  };
}

/** Translate parsed args to CrawlOptions for downstream agents. */
export function toCrawlOptions(args: CliArgs): CrawlOptions {
  assertConcurrency(args.concurrency);
  return {
    source: args.source,
    concurrency: args.concurrency,
    limit: args.limit,
    dry_run: args.dry_run,
    resume: args.resume,
    tag: args.tag,
    cookies: [],
    retry_budget: DEFAULT_RETRY_BUDGET,
    output_dir: path.join("data", "crawler", args.source),
  };
}

/** Convenience: ensure output dir + write a metadata header line. */
export async function writeHeader(outputDir: string, source: Source): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });
  const header = {
    _meta: {
      source,
      license_note: `${source} public pages; no check-in/heart; dev-mode replay`,
      generated_at: new Date().toISOString(),
    },
  };
  return JSON.stringify(header);
}
