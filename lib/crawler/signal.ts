/**
 * lib/crawler/signal.ts
 *
 * SIGINT / SIGTERM handler. On signal:
 *   1. Mark the run as "interrupted".
 *   2. Persist current state to `<output_dir>/.state.json` so --resume can pick up.
 *   3. Exit with code 130 (128 + SIGINT) — the conventional Ctrl-C exit code.
 *
 * The handler is a single shared instance — registering twice would
 * double-fire on signal, so install() guards against that.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { CrawlState } from "./contracts.ts";
import { STATE_FILENAME } from "./contracts.ts";

const HANDLER_KEY = "__crawlerSigHandlers";

type SignalListenerMap = Map<NodeJS.Signals, NodeJS.SignalsListener>;

function listenerMap(): SignalListenerMap {
  const procAny = process as unknown as Record<string, SignalListenerMap | undefined>;
  if (!procAny[HANDLER_KEY]) procAny[HANDLER_KEY] = new Map();
  return procAny[HANDLER_KEY]!;
}

let activeController: AbortController | null = null;

export interface InstallOpts {
  outputDir: string;
  stateProvider: () => Omit<CrawlState, "updated_at">;
  /** Exit hook — defaults to process.exit(130). Tests inject a spy. */
  onExit?: (code: number) => void;
}

export interface SignalHandle {
  abort: AbortSignal;
  uninstall(): void;
}

export function installSignalHandler(opts: InstallOpts): SignalHandle {
  if (activeController) return { abort: activeController.signal, uninstall: uninstallSignalHandler };
  const ctrl = new AbortController();
  activeController = ctrl;
  const exit = opts.onExit ?? ((c: number) => process.exit(c));
  const map = listenerMap();

  const handler = async (sig: NodeJS.Signals): Promise<void> => {
    try {
      const snapshot = opts.stateProvider();
      const state: CrawlState = { ...snapshot, updated_at: new Date().toISOString() };
      await writeState(opts.outputDir, state);
      // stderr — progress bar lives on stdout; keep them separated.
      process.stderr.write(`\n[crawler] received ${sig}; state saved -> ${opts.outputDir}/${STATE_FILENAME}\n`);
      ctrl.abort();
    } catch (err) {
      process.stderr.write(`\n[crawler] failed to persist state: ${(err as Error).message}\n`);
    } finally {
      exit(130);
    }
  };

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    map.set(sig, handler as NodeJS.SignalsListener);
    process.on(sig, handler);
  }

  return { abort: ctrl.signal, uninstall: uninstallSignalHandler };
}

export function uninstallSignalHandler(): void {
  const map = listenerMap();
  for (const [sig, h] of map) process.removeListener(sig, h);
  map.clear();
  activeController = null;
}

export async function writeState(outputDir: string, state: CrawlState): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, STATE_FILENAME);
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, file);
  return file;
}

export async function readState(outputDir: string): Promise<CrawlState | null> {
  try {
    const file = path.join(outputDir, STATE_FILENAME);
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as CrawlState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Helper for tests: synthesise an AbortSignal without touching real signals. */
export function testSignalHandle(): SignalHandle {
  const ctrl = new AbortController();
  return { abort: ctrl.signal, uninstall: () => {} };
}
