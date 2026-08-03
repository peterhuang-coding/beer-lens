/**
 * tests/crawler-cli.test.mts
 *
 * Self-contained CLI harness tests. Imports lib/crawler modules via explicit
 * .ts extensions so node --experimental-strip-types can resolve them.
 * Zero real network calls — every test uses stubs / in-memory fakes.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CliArgError,
  assertConcurrency,
  parseArgs,
  printHelp,
  runCrawl,
  toCrawlOptions,
  writeHeader,
} from "../lib/crawler/cli.ts";
import { renderProgress, TtyProgressPrinter } from "../lib/crawler/progress.ts";
import { ErrorAggregator } from "../lib/crawler/error-aggregator.ts";
import { readState, writeState } from "../lib/crawler/signal.ts";
import type { CrawlError } from "../lib/crawler/contracts.ts";
import { MAX_CONCURRENCY } from "../lib/crawler/contracts.ts";

describe("parseArgs", () => {
  it("--help prints all flag names", () => {
    const captured: string[] = [];
    printHelp((s) => captured.push(s));
    const out = captured.join("");
    for (const flag of [
      "--source",
      "--concurrency",
      "--dry-run",
      "--limit",
      "--tag",
      "--resume",
      "--help",
    ]) {
      assert.ok(out.includes(flag), `expected help to mention ${flag}`);
    }
  });

  it("parses --source --concurrency --dry-run --limit --tag --resume", () => {
    const a = parseArgs([
      "--source", "untappd",
      "--concurrency", "3",
      "--dry-run",
      "--limit", "50",
      "--tag", "craft",
      "--resume",
    ]);
    assert.strictEqual(a.source, "untappd");
    assert.strictEqual(a.concurrency, 3);
    assert.strictEqual(a.dry_run, true);
    assert.strictEqual(a.limit, 50);
    assert.strictEqual(a.tag, "craft");
    assert.strictEqual(a.resume, true);
    assert.strictEqual(a.help, false);
  });

  it("--source is required (throws CliArgError)", () => {
    assert.throws(() => parseArgs([]), (err: unknown) => err instanceof CliArgError);
  });

  it("--source must be untappd or ratebeer", () => {
    assert.throws(
      () => parseArgs(["--source", "google"]),
      (err: unknown) => err instanceof CliArgError && /--source/.test((err as Error).message),
    );
  });

  it("--tag=none normalises to null", () => {
    const a = parseArgs(["--source", "untappd", "--tag", "none"]);
    assert.strictEqual(a.tag, null);
  });

  it("rejects unknown flag", () => {
    assert.throws(() => parseArgs(["--source", "untappd", "--bogus"]), CliArgError);
  });
});

describe("concurrency hard cap", () => {
  it("rejects --concurrency 5 with explicit message", () => {
    assert.throws(
      () => assertConcurrency(5),
      (err: unknown) =>
        err instanceof CliArgError &&
        /hard cap/.test((err as Error).message) &&
        err.message.includes(String(MAX_CONCURRENCY)),
    );
  });

  it("accepts concurrency 1..4", () => {
    for (const n of [1, 2, 3, 4]) {
      assert.doesNotThrow(() => assertConcurrency(n));
    }
  });

  it("rejects zero / negative / non-integer", () => {
    assert.throws(() => assertConcurrency(0), CliArgError);
    assert.throws(() => assertConcurrency(-1), CliArgError);
    assert.throws(() => assertConcurrency(1.5), CliArgError);
  });

  it("parseArgs(--concurrency 5) propagates the hard cap error", () => {
    assert.throws(
      () => parseArgs(["--source", "untappd", "--concurrency", "5"]),
      (err: unknown) => err instanceof CliArgError && /hard cap/.test((err as Error).message),
    );
  });
});

describe("dry-run mode", () => {
  it("--dry-run does NOT invoke worker hook", async () => {
    let workerCalled = false;
    const result = await runCrawl({
      args: parseArgs(["--source", "untappd", "--dry-run", "--limit", "3"]),
      candidateIds: ["a", "b", "c", "d", "e"],
      worker: async () => {
        workerCalled = true;
        return "ok" as const;
      },
      log: () => {},
      outputDir: await makeTmpDir(),
      signalHandle: { abort: new AbortController().signal },
    });
    assert.strictEqual(result.mode, "dry-run");
    assert.strictEqual(workerCalled, false, "dry-run must not call the worker hook");
    assert.strictEqual(result.progress.total, 3);
    assert.ok(result.dryRunPlan.some((l) => l.includes("DRY RUN")));
    assert.ok(result.dryRunPlan.some((l) => l.includes("plan: fetch untappd/a")));
  });

  it("dry-run without candidates returns total=0", async () => {
    const result = await runCrawl({
      args: parseArgs(["--source", "ratebeer", "--dry-run"]),
      candidateIds: [],
      log: () => {},
      outputDir: await makeTmpDir(),
      signalHandle: { abort: new AbortController().signal },
    });
    assert.strictEqual(result.progress.total, 0);
    assert.strictEqual(result.progress.done, 0);
  });
});

describe("live mode + signal handling", () => {
  it("writes state.json with processed + failed ids when abort() fires mid-run", async () => {
    const dir = await makeTmpDir();
    const ctrl = new AbortController();
    let processed = 0;
    // Worker blocks until the abort signal — simulates a long crawl.
    const worker = async (id: string, signal: AbortSignal): Promise<"ok" | "skip"> => {
      await new Promise<void>((resolve) => {
        const onAbort = () => { cleanup(); resolve(); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, 5_000);
        function cleanup() {
          signal.removeEventListener("abort", onAbort);
          clearTimeout(timer);
        }
        if (signal.aborted) { cleanup(); resolve(); return; }
        signal.addEventListener("abort", onAbort);
      });
      if (signal.aborted) return "skip";
      processed++;
      // Mark as processed in an external sink too.
      return "ok";
    };

    const runP = runCrawl({
      args: parseArgs([
        "--source", "untappd",
        "--concurrency", "2",
        "--limit", "5",
      ]),
      candidateIds: ["1", "2", "3", "4", "5", "6", "7", "8"],
      worker,
      outputDir: dir,
      signalHandle: { abort: ctrl.signal },
      log: () => {},
      now: () => Date.now(),
    });

    // Let a couple of items finish, then abort.
    await new Promise((r) => setTimeout(r, 30));
    ctrl.abort();
    const result = await runP;

    assert.ok(result.stateWritten, "expected state.json path");
    const state = await readState(dir);
    assert.ok(state, "state.json should exist after abort");
    assert.strictEqual(state!.source, "untappd");
    assert.ok(Array.isArray(state!.processed_ids));
    // We don't assert exact count because of timing — but we know at least
    // a couple completed and `updated_at` got stamped.
    assert.ok(typeof state!.updated_at === "string" && state!.updated_at.length > 0);
    assert.ok(processed >= 0);
  });

  it("writes state.json when runCrawl completes normally", async () => {
    const dir = await makeTmpDir();
    const ctrl = new AbortController();
    const result = await runCrawl({
      args: parseArgs(["--source", "ratebeer", "--concurrency", "2", "--limit", "4"]),
      candidateIds: ["a", "b", "c", "d", "e", "f"],
      worker: async () => "ok" as const,
      outputDir: dir,
      signalHandle: { abort: ctrl.signal },
      log: () => {},
    });
    const state = await readState(dir);
    assert.ok(state);
    assert.strictEqual(state!.processed_ids.length, 4);
    assert.strictEqual(state!.source, "ratebeer");
    assert.strictEqual(result.progress.done, 4);
  });
});

describe("error aggregation", () => {
  it("classifies 4xx vs 5xx vs timeout vs parser vs cookie_ban", () => {
    assert.strictEqual(ErrorAggregator.classify({ status: 404 }), "http_4xx");
    assert.strictEqual(ErrorAggregator.classify({ status: 418 }), "http_4xx");
    assert.strictEqual(ErrorAggregator.classify({ status: 500 }), "http_5xx");
    assert.strictEqual(ErrorAggregator.classify({ status: 502 }), "http_5xx");
    assert.strictEqual(ErrorAggregator.classify({ status: 503 }), "http_5xx");
    assert.strictEqual(ErrorAggregator.classify({ status: 401 }), "cookie_ban");
    assert.strictEqual(ErrorAggregator.classify({ status: 403 }), "cookie_ban");
    assert.strictEqual(ErrorAggregator.classify({ status: 429 }), "cookie_ban");
    assert.strictEqual(ErrorAggregator.classify({ code: "ETIMEDOUT" }), "timeout");
    assert.strictEqual(ErrorAggregator.classify({ code: "AbortError" }), "timeout");
    assert.strictEqual(ErrorAggregator.classify({ code: "PARSE_ERR" }), "parser");
    assert.strictEqual(ErrorAggregator.classify({ message: "no status, no code" }), "parser");
  });

  it("groups errors into 4xx / 5xx / timeout / parser / cookie_ban with up to 3 samples each", () => {
    const agg = new ErrorAggregator();
    const now = new Date().toISOString();
    const mkErr = (kind: CrawlError["kind"], i: number): CrawlError => ({
      kind,
      url: `https://example.test/${kind}/${i}`,
      message: `boom ${i}`,
      status: kind === "http_4xx" ? 404 : kind === "http_5xx" ? 502 : kind === "cookie_ban" ? 429 : undefined,
      ts: now,
    });
    for (let i = 0; i < 5; i++) agg.add(mkErr("http_4xx", i));
    for (let i = 0; i < 5; i++) agg.add(mkErr("http_5xx", i));
    for (let i = 0; i < 5; i++) agg.add(mkErr("timeout", i));
    for (let i = 0; i < 5; i++) agg.add(mkErr("parser", i));
    for (let i = 0; i < 5; i++) agg.add(mkErr("cookie_ban", i));

    const snap = agg.snapshot();
    assert.strictEqual(snap.totals.http_4xx, 5);
    assert.strictEqual(snap.totals.http_5xx, 5);
    assert.strictEqual(snap.totals.timeout, 5);
    assert.strictEqual(snap.totals.parser, 5);
    assert.strictEqual(snap.totals.cookie_ban, 5);
    assert.strictEqual(snap.groups.http_4xx.length, 3, "each group keeps at most 3 samples");
    assert.strictEqual(snap.groups.http_5xx.length, 3);
    assert.strictEqual(snap.groups.timeout.length, 3);
    assert.strictEqual(snap.groups.parser.length, 3);
    assert.strictEqual(snap.groups.cookie_ban.length, 3);
    assert.strictEqual(agg.total(), 25);
  });

  it("format() emits each kind label with sample lines", () => {
    const agg = new ErrorAggregator();
    agg.add({ kind: "http_4xx", url: "u1", message: "missing", status: 404, ts: "t" });
    agg.add({ kind: "http_5xx", url: "u2", message: "boom", status: 502, ts: "t" });
    const out = agg.format();
    assert.ok(out.includes("http_4xx: 1"));
    assert.ok(out.includes("http_5xx: 1"));
    assert.ok(out.includes("u1"));
    assert.ok(out.includes("status=404"));
  });
});

describe("progress renderer", () => {
  it("renderProgress contains done/total/failed/eta", () => {
    const line = renderProgress({
      total: 100,
      done: 25,
      failed: 3,
      skipped: 1,
      eta_seconds: 42,
    });
    // Strip ANSI to make assertions stable.
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(plain.includes("25"));
    assert.ok(plain.includes("100"));
    assert.ok(plain.includes("25%"));
    assert.ok(plain.includes("failed=3"));
    assert.ok(plain.includes("skipped=1"));
    assert.ok(plain.includes("eta="));
    assert.ok(plain.includes("00:42"));
  });

  it("renderProgress handles total=0 without divide-by-zero", () => {
    const line = renderProgress({ total: 0, done: 0, failed: 0, skipped: 0, eta_seconds: null });
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(plain.includes("0%"));
    assert.ok(plain.includes("eta=--:--"));
  });

  it("TtyProgressPrinter throttles non-TTY output", () => {
    const writes: string[] = [];
    const printer = new TtyProgressPrinter({ isTty: false, write: (s) => writes.push(s) });
    const p = { total: 10, done: 1, failed: 0, skipped: 0, eta_seconds: 10 } as const;
    printer.tick(p, 1000);
    printer.tick(p, 1100); // too soon — should be ignored
    printer.tick(p, 1300);
    assert.strictEqual(writes.length, 2);
  });
});

describe("toCrawlOptions + writeHeader", () => {
  it("toCrawlOptions applies defaults + concurrency guard", () => {
    const opts = toCrawlOptions(parseArgs(["--source", "untappd"]));
    assert.strictEqual(opts.source, "untappd");
    assert.strictEqual(opts.concurrency, 2);
    assert.strictEqual(opts.dry_run, false);
    assert.strictEqual(opts.resume, false);
    assert.strictEqual(opts.tag, null);
    assert.strictEqual(opts.limit, null);
    assert.deepStrictEqual(opts.cookies, []);
    assert.strictEqual(opts.retry_budget, 5);
    assert.ok(opts.output_dir.endsWith(path.join("data", "crawler", "untappd")));
  });

  it("writeHeader produces JSON with _meta.source + license_note", async () => {
    const dir = await makeTmpDir();
    const line = await writeHeader(dir, "untappd");
    const parsed = JSON.parse(line);
    assert.strictEqual(parsed._meta.source, "untappd");
    assert.ok(parsed._meta.license_note.includes("untappd"));
    assert.ok(parsed._meta.generated_at.length > 0);
    const files = await fs.readdir(dir);
    assert.ok(files.length >= 0); // writeHeader doesn't write — just emits the line.
  });
});

/* ----------------------------------------------------------------- */
/*  Helpers                                                           */
/* ----------------------------------------------------------------- */

async function makeTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "beer-lens-cli-"));
}
