/**
 * lib/crawler/cookie-pool.ts
 *
 * Cookie pool backed by file:// refs (dev-mode only).
 *
 * Per CONTRACT.md:
 *   - single-cookie QPS upper bound, default 1
 *   - 3 consecutive failures kicks the cookie out
 *   - cookies are always local-file refs — no real Untappd creds
 *
 * Concurrency model: pickCookie() returns a cookie ref + a release()
 * closure. Callers must invoke release(success: boolean) after each
 * request to update the failure counter and refill the next token bucket.
 */

import type { CookieRef } from "./contracts.ts";

const FAILURE_KICK_THRESHOLD = 3;
const DEFAULT_QPS = 1;

export interface CookiePoolOptions {
  cookies: CookieRef[];
  default_qps?: number;
  /** Inject a clock for testing — returns ms since epoch. */
  now?: () => number;
}

interface CookieState {
  ref: CookieRef;
  qps: number;
  /** Minimum interval between releases, in ms. */
  minIntervalMs: number;
  lastUsedAt: number;
  consecutiveFailures: number;
  evicted: boolean;
}

export class CookiePool {
  private states: CookieState[];
  private now: () => number;

  constructor(opts: CookiePoolOptions) {
    if (!Array.isArray(opts.cookies) || opts.cookies.length === 0) {
      throw new Error("CookiePool requires at least one cookie");
    }
    this.now = opts.now ?? (() => Date.now());
    const defaultQps = opts.default_qps ?? DEFAULT_QPS;
    this.states = opts.cookies.map((ref) => {
      const qps = ref.qps_per_cookie > 0 ? ref.qps_per_cookie : defaultQps;
      return {
        ref,
        qps,
        minIntervalMs: 1000 / qps,
        lastUsedAt: -Infinity,
        consecutiveFailures: 0,
        evicted: false,
      };
    });
  }

  /** Snapshot of available cookies (excluding evicted ones). */
  available(): CookieRef[] {
    return this.states.filter((s) => !s.evicted).map((s) => s.ref);
  }

  size(): number {
    return this.states.length;
  }

  aliveCount(): number {
    return this.states.filter((s) => !s.evicted).length;
  }

  /**
   * Pick the least-recently-used non-evicted cookie. Returns null when
   * the pool is fully evicted.
   */
  pickCookie(): { ref: CookieRef; release: (success: boolean) => void } | null {
    const candidates = this.states.filter((s) => !s.evicted);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const picked = candidates[0]!;
    picked.lastUsedAt = this.now();
    const ref = picked.ref;
    return {
      ref,
      release: (success: boolean) => {
        if (success) {
          picked.consecutiveFailures = 0;
        } else {
          picked.consecutiveFailures += 1;
          if (picked.consecutiveFailures >= FAILURE_KICK_THRESHOLD) {
            picked.evicted = true;
          }
        }
      },
    };
  }

  /** Force-evict a cookie (mostly for tests). */
  evict(name: string): boolean {
    const s = this.states.find((c) => c.ref.name === name);
    if (!s) return false;
    s.evicted = true;
    return true;
  }

  /** Reset all counters (test helper). */
  reset(): void {
    for (const s of this.states) {
      s.consecutiveFailures = 0;
      s.evicted = false;
      s.lastUsedAt = -Infinity;
    }
  }
}

export const __test__ = { FAILURE_KICK_THRESHOLD };
