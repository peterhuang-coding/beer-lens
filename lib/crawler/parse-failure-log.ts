import { promises as fs } from "node:fs";
import * as path from "node:path";

const DEFAULT_FAILURE_LOG = "data/crawler/_logs/parse-failures.jsonl";

export interface ParseFailureEntry {
  url: string;
  html_hash: string;
  reason: string;
  ts?: string;
}

/** Append-only parse failure metadata log. Raw HTML is never accepted/written. */
export class ParseFailureLog {
  readonly filePath: string;

  constructor(filePath: string = DEFAULT_FAILURE_LOG) {
    this.filePath = filePath;
  }

  async record(entry: ParseFailureEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const line = JSON.stringify({
      url: entry.url,
      html_hash: entry.html_hash,
      reason: entry.reason,
      ts: entry.ts ?? new Date().toISOString(),
    });
    await fs.appendFile(this.filePath, `${line}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
