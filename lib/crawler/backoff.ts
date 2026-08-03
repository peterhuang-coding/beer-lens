/**
 * lib/crawler/backoff.ts
 *
 * Exponential backoff with jitter, matching CONTRACT.md:
 *   initial_ms=1000, max_ms=60000, multiplier=2, jitter_ratio=0.3 (±30%).
 *
 * Pure functions, no I/O — easy to unit-test.
 */

import type { BackoffPolicy } from "./contracts.ts";

export const DEFAULT_BACKOFF: BackoffPolicy = {
  initial_ms: 1000,
  max_ms: 60000,
  multiplier: 2,
  jitter_ratio: 0.3,
};

/**
 * Compute delay for attempt `n` (n=0 → initial_ms).
 * Caps at max_ms. Jitter: ±jitter_ratio uniformly.
 *
 * @param policy  - backoff policy knobs
 * @param attempt - 0-based attempt index
 * @param rand    - injectable RNG returning [0,1); defaults to Math.random
 */
export function backoffDelayMs(
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  attempt: number,
  rand: () => number = Math.random,
): number {
  if (attempt < 0) attempt = 0;
  const base = policy.initial_ms * Math.pow(policy.multiplier, attempt);
  const capped = Math.min(base, policy.max_ms);
  const jitter = (rand() * 2 - 1) * policy.jitter_ratio; // [-ratio, +ratio]
  return Math.max(0, Math.round(capped * (1 + jitter)));
}

/**
 * Sleep helper that applies backoffDelayMs and awaits.
 * Returns the actual delay used (for logging).
 */
export async function sleepBackoff(
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  attempt: number,
  rand: () => number = Math.random,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<number> {
  const ms = backoffDelayMs(policy, attempt, rand);
  await sleep(ms);
  return ms;
}
