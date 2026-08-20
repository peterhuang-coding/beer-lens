/**
 * Vision error hierarchy + classifier.
 *
 * Each error carries a `code` (stable string for telemetry / rule engines),
 * a `retriable` flag (the container uses this to decide whether to walk the
 * fallback chain or short-circuit), and provider/model context.
 */

export type VisionErrorCode =
  | "TIMEOUT"
  | "NETWORK"
  | "PARSE"
  | "RATE_LIMIT"
  | "AUTH"
  | "SIZE"
  | "ALL_PROVIDERS_FAILED"
  | "BLOCKED"
  | "UNKNOWN";

export abstract class VisionError extends Error {
  abstract readonly code: VisionErrorCode;
  abstract readonly retriable: boolean;
  /** Set when the error blocks the user-visible flow (rules engine veto). */
  readonly userBlocker: boolean = false;

  readonly provider: string | undefined;
  readonly model: string | undefined;

  constructor(
    message: string,
    provider?: string,
    model?: string,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.provider = provider;
    this.model = model;
  }
}

export class VisionTimeoutError extends VisionError {
  readonly code = "TIMEOUT" as const;
  readonly retriable = true;
}
export class VisionNetworkError extends VisionError {
  readonly code = "NETWORK" as const;
  readonly retriable = true;
}
export class VisionParseError extends VisionError {
  readonly code = "PARSE" as const;
  readonly retriable = false;
}
export class VisionRateLimitError extends VisionError {
  readonly code = "RATE_LIMIT" as const;
  readonly retriable = true;
}
export class VisionAuthError extends VisionError {
  readonly code = "AUTH" as const;
  readonly retriable = false;
}
export class VisionSizeError extends VisionError {
  readonly code = "SIZE" as const;
  readonly retriable = false;
}
export class VisionAllProvidersFailedError extends VisionError {
  readonly code = "ALL_PROVIDERS_FAILED" as const;
  readonly retriable = false;
}
export class VisionBlockedError extends VisionError {
  readonly code = "BLOCKED" as const;
  readonly retriable = false;
  readonly userBlocker = true;
}

/**
 * Classify an arbitrary caught error into a VisionError subclass.
 * If already a VisionError, returns as-is. Otherwise pattern-matches on
 * common error message fragments.
 */
export function classify(err: unknown, provider?: string, model?: string): VisionError {
  if (err instanceof VisionError) return err;

  const e = err as { name?: string; message?: string } | null | undefined;
  const msg = String(e?.message ?? err ?? "");
  const name = e?.name ?? "";

  if (name === "AbortError" || /timeout|timed\s*out|aborted/i.test(msg)) {
    return new VisionTimeoutError(msg, provider, model);
  }
  if (/429|rate.?limit|too\s*many\s*requests/i.test(msg)) {
    return new VisionRateLimitError(msg, provider, model);
  }
  if (/401|403|unauthorized|forbidden|api.?key/i.test(msg)) {
    return new VisionAuthError(msg, provider, model);
  }
  if (/413|payload\s*too\s*large|too\s*large/i.test(msg)) {
    return new VisionSizeError(msg, provider, model);
  }
  if (/parse|invalid\s*json|json\s*error/i.test(msg)) {
    return new VisionParseError(msg, provider, model);
  }
  if (
    /fetch\s*failed|ECONN|ETIMEDOUT|econnreset|enotfound|network|getaddrinfo|proxy|socks/i.test(
      msg,
    )
  ) {
    return new VisionNetworkError(msg, provider, model);
  }
  return new VisionAllProvidersFailedError(msg, provider, model);
}

/**
 * Build a single ALL_PROVIDERS_FAILED error from a sequence of attempts.
 */
export function allProvidersFailed(
  capability: string,
  attempts: Array<{ provider: string; model: string; err: unknown }>,
): VisionAllProvidersFailedError {
  const lines = attempts.map(
    (a, i) => {
      const ve = classify(a.err, a.provider, a.model);
      return `  [${i}] ${a.provider}/${a.model}: ${ve.code} ${ve.message.slice(0, 120)}`;
    },
  );
  return new VisionAllProvidersFailedError(
    `All vision providers failed for ${capability}:\n${lines.join("\n")}`,
  );
}