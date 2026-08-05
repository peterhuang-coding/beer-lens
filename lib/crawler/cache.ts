import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { BeerRecord } from "./contracts.ts";
import { validateBeerRecord } from "./validate-beer-record.ts";

const DEFAULT_CACHE_DIR = "data/crawler/_cache/llm/";
const DEFAULT_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface HtmlHashCacheOptions {
  dir?: string;
  ttlDays?: number;
}

function htmlHash(html: string): string {
  return createHash("sha256").update(html).digest("hex");
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/** Successful BeerRecord cache keyed by a SHA-256 digest of the source HTML. */
export class HtmlHashCache {
  readonly dir: string;
  readonly #ttlMs: number;

  constructor(opts: HtmlHashCacheOptions = {}) {
    const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
    if (!Number.isFinite(ttlDays) || ttlDays < 0) {
      throw new RangeError("ttlDays must be a non-negative finite number");
    }
    this.dir = opts.dir ?? DEFAULT_CACHE_DIR;
    this.#ttlMs = ttlDays * DAY_MS;
  }

  async get(html: string): Promise<BeerRecord | null> {
    await this.#removeExpiredFiles();
    const cachePath = this.#pathFor(html);

    let raw: string;
    try {
      raw = await fs.readFile(cachePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      return validateBeerRecord(parsed);
    } catch {
      await fs.rm(cachePath, { force: true });
      return null;
    }
  }

  async set(html: string, record: BeerRecord): Promise<void> {
    const validated = validateBeerRecord(record);
    await fs.mkdir(this.dir, { recursive: true });

    const cachePath = this.#pathFor(html);
    const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(validated), {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await fs.rename(temporaryPath, cachePath);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }

  #pathFor(html: string): string {
    return path.join(this.dir, `${htmlHash(html)}.json`);
  }

  async #removeExpiredFiles(): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }

    const now = Date.now();
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const cachePath = path.join(this.dir, entry.name);
          try {
            const stats = await fs.stat(cachePath);
            if (now - stats.mtimeMs >= this.#ttlMs) {
              await fs.rm(cachePath, { force: true });
            }
          } catch (error) {
            if (!isErrno(error, "ENOENT")) throw error;
          }
        }),
    );
  }
}
