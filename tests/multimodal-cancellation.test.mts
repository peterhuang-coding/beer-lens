/**
 * Caller-cancellation contract for the multimodal container boundary.
 *
 * Scope of these tests:
 *   - optional AbortSignal on ContainerCallOptions, forwarded by IDENTITY
 *     to provider.call (no signal is fabricated when the caller passes none)
 *   - pre-aborted calls fail with the existing redacted TIMEOUT error type
 *     before any provider call AND before a warm-cache lookup
 *   - abort during a cooperative provider rejects with TIMEOUT and is
 *     terminal: no further models/providers are attempted
 *   - a noncooperative provider that ignores the signal and resolves late:
 *     the result is neither returned nor cached (the in-flight work itself
 *     cannot be forcibly stopped — JS promises are not cancellable)
 *   - no-signal behavior is unchanged: success/warm cache and retriable
 *     fallback still walk exactly as before
 *   - cancellation never leaks signal.reason, prompt, image bytes or
 *     credential material into the thrown error or trace entries
 *
 * Every provider here is synthetic; no network, credentials, timers beyond
 * the container contract, or real provider configuration are involved.
 *
 * Run with:
 *   node --import tsx --test tests/multimodal-cancellation.test.mts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  vision,
  registerCapability,
  registerProvider,
  invalidateCache,
  VisionTimeoutError,
} from "../lib/multimodal/index.ts";
import { runWithTrace } from "../lib/harness/trace-context.ts";
import {
  clearTraceEntries,
  getTreeByRoot,
} from "../lib/harness/trace-buffer.ts";
import type { VisionProvider } from "../lib/multimodal/providers/base.ts";
import type { CapabilityInput } from "../lib/multimodal/types.ts";

const INPUT: CapabilityInput = {
  image: { base64: "aGVsbG8=", mime: "image/jpeg" },
  prompt: "describe this beer",
};

interface SigRecord {
  model: string;
  signal: AbortSignal | undefined;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Cooperative synthetic provider: rejects with an AbortError as soon as the
 * forwarded signal aborts. If no signal ever reaches it (the container
 * defect) it resolves after `autoResolveMs`, which makes the cancellation
 * tests fail fast instead of hanging.
 */
function cooperativeProvider(
  id: string,
  rec: SigRecord[],
  autoResolveMs = 30,
): void {
  const provider: VisionProvider = {
    id,
    call(_input: CapabilityInput, opts: { model: string; signal?: AbortSignal }) {
      rec.push({ model: opts.model, signal: opts.signal });
      return new Promise<string>((resolve, reject) => {
        const t = setTimeout(
          () => resolve(JSON.stringify({ provider: id, model: opts.model })),
          autoResolveMs,
        );
        opts.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            const e = new Error("The operation was aborted");
            e.name = "AbortError";
            reject(e);
          },
          { once: true },
        );
      });
    },
  };
  registerProvider(provider);
}

/**
 * Noncooperative synthetic provider: accepts the signal but never observes
 * it. Each call hands back a deferred the test resolves/rejects manually,
 * so a late resolution after abort can be simulated deterministically.
 */
function ignoringProvider(
  id: string,
  rec: SigRecord[],
): { pending: Array<Deferred<string>> } {
  const pending: Array<Deferred<string>> = [];
  const provider: VisionProvider = {
    id,
    call(_input: CapabilityInput, opts: { model: string; signal?: AbortSignal }) {
      rec.push({ model: opts.model, signal: opts.signal });
      const d = deferred<string>();
      pending.push(d);
      return d.promise;
    },
  };
  registerProvider(provider);
  return { pending };
}

function instantProvider(
  id: string,
  rec: SigRecord[],
  raw: string,
): void {
  const provider: VisionProvider = {
    id,
    call(_input: CapabilityInput, opts: { model: string; signal?: AbortSignal }) {
      rec.push({ model: opts.model, signal: opts.signal });
      return Promise.resolve(raw);
    },
  };
  registerProvider(provider);
}

function registerCap(
  capId: string,
  specs: Array<{ provider: string; models: string[] }>,
): void {
  registerCapability({
    id: capId,
    description: "synthetic cancellation test capability",
    defaultProviders: specs.map((s) => ({
      provider: s.provider,
      models: s.models,
      timeoutMs: 5_000,
    })),
  });
}

// ── Pre-abort: cold cache ────────────────────────────────────────────────────

test(
  "pre-aborted call fails with redacted TIMEOUT before any provider call (cold cache)",
  { timeout: 3_000 },
  async () => {
    invalidateCache();
    const rec: SigRecord[] = [];
    cooperativeProvider("cancel-pre-cold-prov", rec, 1_000);
    registerCap("cancel_pre_cold_cap", [{ provider: "cancel-pre-cold-prov", models: ["m1"] }]);

    const ac = new AbortController();
    ac.abort(new Error("SECRET_REASON_MARKER"));

    await assert.rejects(
      () => vision.call("cancel_pre_cold_cap", INPUT, { signal: ac.signal }),
      (e: unknown) => {
        assert.ok(e instanceof VisionTimeoutError, `expected TIMEOUT, got ${String(e)}`);
        assert.equal((e as VisionTimeoutError).code, "TIMEOUT");
        assert.ok(
          !String((e as Error).message).includes("SECRET_REASON_MARKER"),
          "signal.reason must not appear in the error",
        );
        return true;
      },
    );
    assert.equal(rec.length, 0, "no provider call may be made for a pre-aborted call");
  },
);

// ── Pre-abort: warm cache must not be consulted ─────────────────────────────

test(
  "pre-aborted call fails before warm-cache lookup and leaves the cache intact",
  { timeout: 3_000 },
  async () => {
    invalidateCache();
    const rec: SigRecord[] = [];
    instantProvider("cancel-pre-warm-prov", rec, '{"cached":true}');
    registerCap("cancel_pre_warm_cap", [{ provider: "cancel-pre-warm-prov", models: ["m1"] }]);

    const first = await vision.call("cancel_pre_warm_cap", INPUT);
    assert.equal(first.fromCache, false);
    const warm = await vision.call("cancel_pre_warm_cap", INPUT);
    assert.equal(warm.fromCache, true);
    assert.equal(rec.length, 1);

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => vision.call("cancel_pre_warm_cap", INPUT, { signal: ac.signal }),
      (e: unknown) => e instanceof VisionTimeoutError,
    );

    // Cancellation happened before the cache read: provider still untouched…
    assert.equal(rec.length, 1, "warm-cache attempt must not become a provider call");
    // …and the cached value is still servable to a later, live caller.
    const after = await vision.call("cancel_pre_warm_cap", INPUT);
    assert.equal(after.fromCache, true);
    assert.equal(after.raw, '{"cached":true}');
  },
);

// ── Active abort: cooperative provider, terminal, no fallback ───────────────

test(
  "abort during a cooperative provider rejects TIMEOUT and stops all later models/providers; signal is forwarded by identity",
  { timeout: 3_000 },
  async () => {
    invalidateCache();
    const recA: SigRecord[] = [];
    const recB: SigRecord[] = [];
    cooperativeProvider("cancel-active-a", recA);
    instantProvider("cancel-active-b", recB, '{"from":"B"}');
    registerCap("cancel_active_cap", [
      { provider: "cancel-active-a", models: ["m1", "m2"] },
      { provider: "cancel-active-b", models: ["b1"] },
    ]);

    const ac = new AbortController();
    const signal = ac.signal;
    setTimeout(() => ac.abort(new Error("SECRET_REASON_MARKER")), 15);

    await assert.rejects(
      () => vision.call("cancel_active_cap", INPUT, { signal }),
      (e: unknown) => {
        assert.ok(e instanceof VisionTimeoutError);
        assert.equal((e as VisionTimeoutError).code, "TIMEOUT");
        assert.ok(!String((e as Error).message).includes("SECRET_REASON_MARKER"));
        return true;
      },
    );

    assert.deepEqual(recA.map((r) => r.model), ["m1"], "only the in-flight model ran");
    assert.equal(recA[0]?.signal, signal, "the SAME signal object must be forwarded");
    assert.equal(recB.length, 0, "fallback providers must never be reached after abort");
  },
);

// ── Abort while walking the fallback chain ──────────────────────────────────

test(
  "abort during fallback is terminal for remaining models and providers",
  { timeout: 3_000 },
  async () => {
    invalidateCache();
    const recA: SigRecord[] = [];
    const recB: SigRecord[] = [];
    // First model fails retriably before abort fires; second model is
    // cooperative and gets aborted.
    registerProvider({
      id: "cancel-chain-a",
      call(_input: CapabilityInput, opts: { model: string; signal?: AbortSignal }) {
        recA.push({ model: opts.model, signal: opts.signal });
        if (opts.model === "broken") {
          return new Promise((_, reject) =>
            setTimeout(() => reject(new Error("429 rate limit exceeded")), 10),
          );
        }
        return new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve('{"ok":true}'), 200);
          opts.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              const e = new Error("The operation was aborted");
              e.name = "AbortError";
              reject(e);
            },
            { once: true },
          );
        });
      },
    });
    instantProvider("cancel-chain-b", recB, '{"from":"B"}');
    registerCap("cancel_chain_cap", [
      { provider: "cancel-chain-a", models: ["broken", "next"] },
      { provider: "cancel-chain-b", models: ["b1"] },
    ]);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 25);

    await assert.rejects(
      () => vision.call("cancel_chain_cap", INPUT, { signal: ac.signal }),
      (e: unknown) => e instanceof VisionTimeoutError,
    );

    assert.deepEqual(recA.map((r) => r.model), ["broken", "next"]);
    assert.equal(recB.length, 0, "next provider spec must not run after abort");
  },
);

// ── Terminal race: ignored abort + late resolution is dropped, not cached ───

test(
  "noncooperative late success after abort is neither returned nor cached",
  { timeout: 3_000 },
  async () => {
    invalidateCache();
    const rec: SigRecord[] = [];
    const { pending } = ignoringProvider("cancel-ignore-prov", rec);
    registerCap("cancel_ignore_cap", [{ provider: "cancel-ignore-prov", models: ["m1"] }]);

    const ac = new AbortController();
    const callP = vision.call("cancel_ignore_cap", INPUT, { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("SECRET_REASON_MARKER")), 15);
    // Provider ignores the signal and "finishes" afterwards.
    setTimeout(() => pending[0]?.resolve('{"late":"SECRET_LATE_MARKER"}'), 45);

    await assert.rejects(
      () => callP,
      (e: unknown) => {
        assert.ok(e instanceof VisionTimeoutError);
        const msg = String((e as Error).message);
        assert.ok(!msg.includes("SECRET_REASON_MARKER"));
        assert.ok(!msg.includes("SECRET_LATE_MARKER"), "late response must not be returned");
        return true;
      },
    );
    assert.equal(rec.length, 1);

    // A later, live call with the same request must hit the provider again:
    // the aborted late result was never written to the cache.
    const retryP = vision.call("cancel_ignore_cap", INPUT);
    assert.equal(rec.length, 2, "aborted result must not have populated the cache");
    pending[1]?.resolve('{"fresh":true}');
    const retry = await retryP;
    assert.equal(retry.fromCache, false);
    assert.equal(retry.raw, '{"fresh":true}');
  },
);

// ── No-signal compatibility: success + warm cache ───────────────────────────

test("no signal: normal success then warm cache hit, provider sees undefined signal", async () => {
  invalidateCache();
  const rec: SigRecord[] = [];
  instantProvider("cancel-nosig-ok", rec, '{"ok":true}');
  registerCap("cancel_nosig_ok_cap", [{ provider: "cancel-nosig-ok", models: ["m1"] }]);

  const first = await vision.call("cancel_nosig_ok_cap", INPUT);
  const second = await vision.call("cancel_nosig_ok_cap", INPUT);

  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(rec.length, 1);
  assert.equal(rec[0]?.signal, undefined, "container must not fabricate a signal");
});

// ── No-signal compatibility: retriable fallback still walks ─────────────────

test("no signal: retriable failure still walks to the next model", async () => {
  invalidateCache();
  const rec: SigRecord[] = [];
  registerProvider({
    id: "cancel-nosig-fallback",
    call(_input: CapabilityInput, opts: { model: string; signal?: AbortSignal }) {
      rec.push({ model: opts.model, signal: opts.signal });
      if (opts.model === "broken") return Promise.reject(new Error("429 rate limit exceeded"));
      return Promise.resolve('{"items":[]}');
    },
  });
  registerCap("cancel_nosig_fallback_cap", [
    { provider: "cancel-nosig-fallback", models: ["broken", "ok"] },
  ]);

  const result = await vision.call("cancel_nosig_fallback_cap", INPUT);
  assert.deepEqual(rec.map((r) => r.model), ["broken", "ok"]);
  assert.equal(result.model, "ok");
  assert.equal(result.fromCache, false);
  assert.equal(result.attempts[0]?.ok, false);
  assert.equal(result.attempts[0]?.errorCode, "RATE_LIMIT");
  assert.equal(result.attempts[1]?.ok, true);
  assert.equal(rec[0]?.signal, undefined);
});

// ── Signal identity for a live (non-aborted) caller ─────────────────────────

test("a live caller signal is the exact object provider.call receives", async () => {
  invalidateCache();
  const rec: SigRecord[] = [];
  instantProvider("cancel-identity-prov", rec, '{"ok":true}');
  registerCap("cancel_identity_cap", [{ provider: "cancel-identity-prov", models: ["m1"] }]);

  const ac = new AbortController();
  const result = await vision.call("cancel_identity_cap", INPUT, { signal: ac.signal });
  assert.equal(result.raw, '{"ok":true}');
  assert.equal(rec[0]?.signal, ac.signal);
});

// ── A live signal does not change cache identity ────────────────────────────

test("a live signal on a repeated call does not defeat the warm cache", async () => {
  invalidateCache();
  const rec: SigRecord[] = [];
  instantProvider("cancel-live-cache-prov", rec, '{"ok":true}');
  registerCap("cancel_live_cache_cap", [{ provider: "cancel-live-cache-prov", models: ["m1"] }]);

  await vision.call("cancel_live_cache_cap", INPUT);
  const hit = await vision.call("cancel_live_cache_cap", INPUT, {
    signal: new AbortController().signal,
  });
  assert.equal(hit.fromCache, true);
  assert.equal(rec.length, 1, "cache keys must not depend on the signal");
});

// ── Redaction: error text and trace stay clean on active abort ──────────────

test(
  "cancellation error and trace decisions never carry reason, prompt tail, image or credentials",
  { timeout: 3_000 },
  async () => {
    invalidateCache();
    clearTraceEntries();
    const rec: SigRecord[] = [];

    // A provider whose cooperative rejection is stuffed with every secret.
    // The container must discard that error and emit its own fixed text.
    registerProvider({
      id: "cancel-redact-prov",
      call(_input: CapabilityInput, opts: { model: string; signal?: AbortSignal }) {
        rec.push({ model: opts.model, signal: opts.signal });
        return new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve('{"ok":true}'), 500);
          opts.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(
                new Error(
                  "AbortError after Bearer sk-SECRET_CRED_MARKER " +
                    "SECRET_REASON_MARKER SECRET_PROMPT_MARKER SECRET_IMG_MARKER",
                ),
              );
            },
            { once: true },
          );
        });
      },
    });
    registerCap("cancel_redact_cap", [{ provider: "cancel-redact-prov", models: ["m1"] }]);

    // Secret prompt material sits past the 80-char trace preview window, so
    // vision:enter cannot contain it; only a leak in the cancellation path
    // could put it into a trace entry.
    const secretInput: CapabilityInput = {
      image: { base64: "SECRET_IMG_MARKER-bytes", mime: "image/jpeg" },
      prompt: "x".repeat(100) + " SECRET_PROMPT_MARKER",
    };

    const root = 9_000_000_000_000 + Math.floor(Math.random() * 1_000_000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("SECRET_REASON_MARKER")), 15);

    await runWithTrace({ root_ts: root, parent_ts: null }, async () => {
      await assert.rejects(
        () => vision.call("cancel_redact_cap", secretInput, { signal: ac.signal }),
        (e: unknown) => {
          assert.ok(e instanceof VisionTimeoutError);
          assert.equal(
            (e as Error).message,
            "vision call canceled before completion",
            "error must use the fixed redacted copy",
          );
          return true;
        },
      );
    });

    const tree = getTreeByRoot(root);
    assert.ok(tree.length > 0, "expected trace entries for the canceled call");
    const dump = JSON.stringify(tree);
    for (const marker of [
      "SECRET_CRED_MARKER",
      "SECRET_REASON_MARKER",
      "SECRET_PROMPT_MARKER",
      "SECRET_IMG_MARKER",
    ]) {
      assert.ok(!dump.includes(marker), `trace must not contain ${marker}`);
    }

    const fails = tree.filter((t) => t.stage === "vision:attempt_fail");
    assert.equal(fails.length, 1, "exactly one terminal attempt_fail entry");
    assert.equal(fails[0]?.decision?.error_code, "TIMEOUT");
    assert.equal(fails[0]?.decision?.retriable, false);
    assert.equal(fails[0]?.decision?.error_message, "canceled");
    assert.ok(
      !tree.some((t) => t.stage === "vision:all_failed"),
      "cancellation is terminal, not an all-providers-failed outcome",
    );
    assert.equal(rec.length, 1);
  },
);

// ── Regression: a provider whose call() throws SYNCHRONOUSLY ─────────────────
//
// A non-async `call()` that raises before returning a promise must settle the
// attempt exactly like an asynchronous rejection: the thrown error enters the
// existing classifier and the retriable fallback walk continues. Previously
// the synchronous throw leaked straight out of the container.

test("no signal: a synchronously throwing provider is classified NETWORK and the fallback provider still runs", async () => {
  invalidateCache();
  const recPrimary: SigRecord[] = [];
  const recFallback: SigRecord[] = [];
  registerProvider({
    id: "cancel-sync-throw-nosig",
    call(_input: CapabilityInput, opts: { model: string; signal?: AbortSignal }) {
      recPrimary.push({ model: opts.model, signal: opts.signal });
      throw new TypeError("synthetic network failure");
    },
  });
  instantProvider("cancel-sync-throw-nosig-fb", recFallback, '{"from":"fallback"}');
  registerCap("cancel_sync_throw_nosig_cap", [
    { provider: "cancel-sync-throw-nosig", models: ["m1"] },
    { provider: "cancel-sync-throw-nosig-fb", models: ["b1"] },
  ]);

  const result = await vision.call("cancel_sync_throw_nosig_cap", INPUT);

  assert.equal(result.provider, "cancel-sync-throw-nosig-fb");
  assert.equal(result.model, "b1");
  assert.equal(result.fromCache, false);
  assert.deepEqual(recPrimary.map((r) => r.model), ["m1"]);
  assert.equal(recPrimary[0]?.signal, undefined, "no signal must be fabricated");
  assert.equal(recFallback.length, 1, "fallback must run after a synchronous throw");
  assert.equal(result.attempts[0]?.ok, false);
  assert.equal(
    result.attempts[0]?.errorCode,
    "NETWORK",
    "synchronous TypeError must enter the existing classifier",
  );
});

test("live signal: a synchronously throwing provider is still classified NETWORK, falls back, and keeps signal identity", async () => {
  invalidateCache();
  const recPrimary: SigRecord[] = [];
  const recFallback: SigRecord[] = [];
  registerProvider({
    id: "cancel-sync-throw-live",
    call(_input: CapabilityInput, opts: { model: string; signal?: AbortSignal }) {
      recPrimary.push({ model: opts.model, signal: opts.signal });
      throw new TypeError("synthetic network failure");
    },
  });
  instantProvider("cancel-sync-throw-live-fb", recFallback, '{"from":"fallback"}');
  registerCap("cancel_sync_throw_live_cap", [
    { provider: "cancel-sync-throw-live", models: ["m1"] },
    { provider: "cancel-sync-throw-live-fb", models: ["b1"] },
  ]);

  const ac = new AbortController();
  const result = await vision.call("cancel_sync_throw_live_cap", INPUT, {
    signal: ac.signal,
  });

  assert.equal(result.provider, "cancel-sync-throw-live-fb");
  assert.equal(recFallback.length, 1);
  assert.equal(result.attempts[0]?.errorCode, "NETWORK");
  assert.equal(
    recPrimary[0]?.signal,
    ac.signal,
    "the live caller signal is still forwarded by identity",
  );
});

test("synchronous abort-and-throw at the provider boundary is terminal redacted TIMEOUT with no fallback", async () => {
  invalidateCache();
  const recPrimary: SigRecord[] = [];
  const recFallback: SigRecord[] = [];
  const ac = new AbortController();
  registerProvider({
    id: "cancel-sync-abort-throw",
    call(_input: CapabilityInput, opts: { model: string; signal?: AbortSignal }) {
      recPrimary.push({ model: opts.model, signal: opts.signal });
      // Harness simulation of cancellation landing at the provider-call
      // boundary: a non-async provider observes the caller signal abort in
      // the same synchronous tick it starts and RAISES instead of returning
      // a rejected promise.
      ac.abort(new Error("SECRET_REASON_MARKER"));
      const e = new Error("The operation was aborted after Bearer sk-SECRET_CRED_MARKER");
      e.name = "AbortError";
      throw e;
    },
  });
  instantProvider("cancel-sync-abort-throw-fb", recFallback, '{"from":"fallback"}');
  registerCap("cancel_sync_abort_throw_cap", [
    { provider: "cancel-sync-abort-throw", models: ["m1", "m2"] },
    { provider: "cancel-sync-abort-throw-fb", models: ["b1"] },
  ]);

  await assert.rejects(
    () => vision.call("cancel_sync_abort_throw_cap", INPUT, { signal: ac.signal }),
    (e: unknown) => {
      assert.ok(e instanceof VisionTimeoutError);
      assert.equal((e as VisionTimeoutError).code, "TIMEOUT");
      const msg = String((e as Error).message);
      assert.equal(msg, "vision call canceled before completion");
      assert.ok(!msg.includes("SECRET_REASON_MARKER"), "signal.reason must not leak");
      assert.ok(!msg.includes("SECRET_CRED_MARKER"), "provider error text must not leak");
      return true;
    },
  );

  assert.deepEqual(recPrimary.map((r) => r.model), ["m1"], "only the in-flight model ran");
  assert.equal(recPrimary[0]?.signal, ac.signal);
  assert.equal(recFallback.length, 0, "no later model or provider may run after cancellation");
});

test(
  "a noncooperative late REJECTION after abort is swallowed: terminal TIMEOUT, no fallback, no unhandled rejection",
  { timeout: 3_000 },
  async () => {
    invalidateCache();
    const recFallback: SigRecord[] = [];
    const { pending } = ignoringProvider("cancel-late-reject-prov", []);
    instantProvider("cancel-late-reject-fb", recFallback, '{"from":"fallback"}');
    registerCap("cancel_late_reject_cap", [
      { provider: "cancel-late-reject-prov", models: ["m1"] },
      { provider: "cancel-late-reject-fb", models: ["b1"] },
    ]);

    const ac = new AbortController();
    const callP = vision.call("cancel_late_reject_cap", INPUT, { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("SECRET_REASON_MARKER")), 10);

    await assert.rejects(
      () => callP,
      (e: unknown) => {
        assert.ok(e instanceof VisionTimeoutError);
        assert.equal((e as VisionTimeoutError).code, "TIMEOUT");
        assert.ok(
          !String((e as Error).message).includes("SECRET_REASON_MARKER"),
          "signal.reason must not leak",
        );
        return true;
      },
    );

    // The noncooperative provider rejects AFTER the abort race settled. The
    // settlement wrapper must consume that rejection: it can never reach the
    // classifier, the fallback walk, the cache, or the event loop as an
    // unhandled rejection.
    setTimeout(
      () => pending[0]?.reject(new Error("500 network SECRET_LATE_REJECT_MARKER")),
      30,
    );
    // Flush the late rejection and its reaction microtasks before asserting;
    // an unconsumed rejection would fail the whole test process.
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(recFallback.length, 0, "fallback must not run after cancellation");

    // The process remains healthy: a later, live call still works end to end.
    const recOk: SigRecord[] = [];
    instantProvider("cancel-late-reject-ok", recOk, '{"healthy":true}');
    registerCap("cancel_late_reject_ok_cap", [
      { provider: "cancel-late-reject-ok", models: ["m1"] },
    ]);
    const after = await vision.call("cancel_late_reject_ok_cap", INPUT);
    assert.equal(after.raw, '{"healthy":true}');
    assert.equal(recOk.length, 1);
  },
);
