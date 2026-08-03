/**
 * lib/crawler/progress.ts
 *
 * ANSI-coloured progress bar (single line, refresh every ~200ms).
 * No external deps — uses raw `\x1b[` escapes so it works in any TTY that
 * supports basic SGR. The renderer is safe to call from the main tick loop
 * (it throttles internally based on PROGRESS_TICK_MS).
 *
 * NOTE: uses `import type` for shared type signatures — see contracts.ts.
 */

import type { CrawlProgress } from "./contracts.ts";
import { PROGRESS_TICK_MS } from "./contracts.ts";

/** ANSI escape helpers — kept inline so no extra module surface. */
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const GREEN = `${ESC}32m`;
const CYAN = `${ESC}36m`;
const YELLOW = `${ESC}33m`;
const RED = `${ESC}31m`;
const MAGENTA = `${ESC}35m`;

function fmtEta(seconds: number | null): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return "--:--";
  const s = Math.floor(seconds);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function bar(done: number, total: number, width = 24): string {
  if (total <= 0) return "[" + " ".repeat(width) + "]";
  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.round(ratio * width);
  return "[" + "=".repeat(filled) + " ".repeat(width - filled) + "]";
}

/** Snapshot renderer — pure: takes a progress snapshot and returns one line. */
export function renderProgress(p: CrawlProgress): string {
  const eta = fmtEta(p.eta_seconds);
  const pct = p.total > 0 ? Math.floor((p.done / p.total) * 100) : 0;
  const failedTxt = p.failed > 0 ? `${RED}failed=${p.failed}${RESET}` : `${DIM}failed=0${RESET}`;
  const skippedTxt = p.skipped > 0 ? `${YELLOW}skipped=${p.skipped}${RESET}` : `${DIM}skipped=0${RESET}`;
  return (
    `${CYAN}crawl${RESET} ${bar(p.done, p.total)} ` +
    `${BOLD}${p.done}${RESET}${DIM}/${RESET}${p.total} ` +
    `${MAGENTA}${pct}%${RESET} ` +
    `${failedTxt} ${skippedTxt} ` +
    `${DIM}eta=${RESET}${GREEN}${eta}${RESET}`
  );
}

/**
 * TtyProgressPrinter — owns a single line that it overwrites on each tick.
 * Falls back to plain prints when not a TTY (CI / piped output).
 */
export class TtyProgressPrinter {
  private lastRenderMs = 0;
  private lastLine = "";
  private readonly isTty: boolean;
  private readonly writeFn: (s: string) => void;

  constructor(opts?: { isTty?: boolean; write?: (s: string) => void }) {
    this.isTty = opts?.isTty ?? Boolean(process.stdout?.isTTY);
    this.writeFn = opts?.write ?? ((s: string) => process.stdout.write(s));
  }

  /** Render progress if enough time has elapsed; otherwise no-op. */
  tick(p: CrawlProgress, now: number = Date.now()): void {
    if (now - this.lastRenderMs < PROGRESS_TICK_MS) return;
    this.lastRenderMs = now;
    const line = renderProgress(p);
    if (this.isTty) {
      // Move to col 0, clear line, write, then leave cursor at end.
      this.writeFn(`\r${ESC}2K${line}`);
    } else {
      // For non-TTY, emit newline so logs are line-aligned.
      this.writeFn(line + "\n");
    }
    this.lastLine = line;
  }

  /** Force a flush — typically called on completion. */
  flush(p: CrawlProgress): void {
    this.lastRenderMs = 0;
    this.tick(p);
    if (this.isTty) this.writeFn("\n");
  }

  /** Final summary line printed after the bar closes. */
  summarize(p: CrawlProgress, elapsedMs: number): string {
    const sec = Math.max(1, Math.round(elapsedMs / 1000));
    const rate = p.done > 0 ? (p.done / sec).toFixed(2) : "0.00";
    return (
      `${GREEN}done${RESET} total=${p.total} ok=${p.done} ` +
      `failed=${p.failed} skipped=${p.skipped} ` +
      `${DIM}elapsed=${sec}s rate=${rate}/s${RESET}`
    );
  }
}
