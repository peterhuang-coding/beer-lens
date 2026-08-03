/**
 * lib/crawler/error-aggregator.ts
 *
 * Group crawl errors by kind (4xx / 5xx / timeout / parser / cookie_ban).
 * For each group keep up to N samples (default 3) plus a running total.
 * Exposes a serializable shape that the CLI can pretty-print at exit.
 *
 * NOTE: imports use `import type` because Node's strip-types loader does
 * NOT elide bare `import { TypeOnly }` when the symbol is an interface
 * (the .ts contract says these are shared type signatures, not runtime
 * values — using `import type` lets the runtime module graph stay clean).
 */

import type {
  AggregatedErrors,
  CrawlError,
  CrawlErrorKind,
} from "./contracts.ts";

const ALL_KINDS: CrawlErrorKind[] = [
  "http_4xx",
  "http_5xx",
  "timeout",
  "parser",
  "cookie_ban",
];

const DEFAULT_KEEP = 3;

export function emptyAggregated(): AggregatedErrors {
  const groups: Record<CrawlErrorKind, CrawlError[]> = {
    http_4xx: [],
    http_5xx: [],
    timeout: [],
    parser: [],
    cookie_ban: [],
  };
  const totals: Record<CrawlErrorKind, number> = {
    http_4xx: 0,
    http_5xx: 0,
    timeout: 0,
    parser: 0,
    cookie_ban: 0,
  };
  return { groups, totals };
}

export class ErrorAggregator {
  private state: AggregatedErrors = emptyAggregated();
  private readonly keep: number;

  constructor(opts?: { keep?: number }) {
    this.keep = opts?.keep ?? DEFAULT_KEEP;
  }

  /** Classify a generic error into a CrawlErrorKind. */
  static classify(input: {
    status?: number;
    code?: string;
    message: string;
  }): CrawlErrorKind {
    if (typeof input.status === "number") {
      if (input.status === 401 || input.status === 403) return "cookie_ban";
      if (input.status === 429) return "cookie_ban";
      if (input.status >= 500 && input.status < 600) return "http_5xx";
      if (input.status >= 400 && input.status < 500) return "http_4xx";
    }
    const code = (input.code ?? "").toLowerCase();
    if (
      code.includes("timeout") ||
      code.includes("aborted") ||
      code.includes("etimedout") ||
      code.includes("econnreset") ||
      code.includes("abort")
    ) return "timeout";
    if (code.includes("parse") || code.includes("json") || code.includes("syntax")) return "parser";
    return "parser";
  }

  /** Add an error to the aggregator. Trims stored samples to `keep`. */
  add(err: CrawlError): void {
    const kind = err.kind;
    this.state.totals[kind] += 1;
    const bucket = this.state.groups[kind];
    if (bucket.length < this.keep) {
      bucket.push(err);
    } else {
      // Replace the last kept sample on a rotating basis so newer errors
      // eventually displace older ones — keeps "recent" context visible.
      bucket[this.state.totals[kind] % this.keep] = err;
    }
  }

  /** Bulk ingest — for tests and replay fixtures. */
  ingest(errors: CrawlError[]): void {
    for (const e of errors) this.add(e);
  }

  snapshot(): AggregatedErrors {
    return {
      groups: { ...this.state.groups },
      totals: { ...this.state.totals },
    };
  }

  /** Total error count across all kinds. */
  total(): number {
    return ALL_KINDS.reduce((acc, k) => acc + this.state.totals[k], 0);
  }

  /** Pretty multi-line summary suitable for stdout. */
  format(): string {
    const lines: string[] = [];
    for (const kind of ALL_KINDS) {
      const t = this.state.totals[kind];
      if (t === 0) {
        lines.push(`  ${kind}: 0`);
        continue;
      }
      lines.push(`  ${kind}: ${t} (showing up to ${this.keep})`);
      for (const sample of this.state.groups[kind]) {
        const status = sample.status != null ? ` status=${sample.status}` : "";
        lines.push(`    - ${sample.url}${status} :: ${sample.message}`);
      }
    }
    return lines.join("\n");
  }
}
