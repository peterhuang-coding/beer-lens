/**
 * lib/crawler/jsonl-writer.ts
 *
 * Async streaming JSONL writer with metadata header.
 *
 * CONTRACT.md format:
 *   - data/crawler/<source>/beers.jsonl
 *   - one BeerRecord per line, UTF-8, no pretty-print
 *   - first line: {"_meta": {"source": "...", "license_note": "...", "generated_at": "..."}}
 *
 * Atomic write strategy:
 *   - stream records into a tmp file, then rename() to final path on close()
 *   - fsync the tmp file before rename so partial writes don't leak
 *     into the final target
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

const HEADER_KEY = "_meta";

export interface JsonlWriterOptions {
  output_path: string;
  source: "untappd" | "ratebeer";
  license_note: string;
  generated_at?: string; // ISO; defaults to now
}

export interface JsonlWriterRecord {
  [k: string]: unknown;
}

export class JsonlWriter {
  readonly output_path: string;
  readonly tmp_path: string;
  readonly source: "untappd" | "ratebeer";
  readonly license_note: string;
  readonly generated_at: string;
  private fh: import("node:fs/promises").FileHandle | null = null;
  private recordCount = 0;
  private closed = false;

  constructor(opts: JsonlWriterOptions) {
    this.output_path = opts.output_path;
    this.tmp_path = `${opts.output_path}.tmp-${process.pid}-${Date.now()}`;
    this.source = opts.source;
    this.license_note = opts.license_note;
    this.generated_at = opts.generated_at ?? new Date().toISOString();
  }

  async open(): Promise<void> {
    if (this.fh) return;
    await fs.mkdir(path.dirname(this.output_path), { recursive: true });
    this.fh = await fs.open(this.tmp_path, "w");
    const header = {
      [HEADER_KEY]: {
        source: this.source,
        license_note: this.license_note,
        generated_at: this.generated_at,
      },
    };
    await this.fh.write(_lineFor(header));
  }

  async writeRecord(record: JsonlWriterRecord): Promise<void> {
    if (!this.fh) throw new Error("JsonlWriter not opened");
    if (this.closed) throw new Error("JsonlWriter already closed");
    await this.fh.write(_lineFor(record));
    this.recordCount += 1;
  }

  count(): number {
    return this.recordCount;
  }

  /**
   * Atomic finalize: fsync → close → rename tmp to final.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.fh) {
      this.closed = true;
      return;
    }
    await this.fh.sync();
    await this.fh.close();
    this.fh = null;
    await fs.rename(this.tmp_path, this.output_path);
    this.closed = true;
  }

  /**
   * Abort and remove the tmp file. Safe to call multiple times.
   */
  async abort(): Promise<void> {
    if (this.fh) {
      try {
        await this.fh.close();
      } catch {
        // ignore
      }
      this.fh = null;
    }
    this.closed = true;
    await fs.rm(this.tmp_path, { force: true });
  }
}

function _lineFor(value: object): string {
  return JSON.stringify(value) + "\n";
}
