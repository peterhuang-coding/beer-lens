import type { BeerRecord } from "./contracts.ts";
import { BEER_RECORD_SYSTEM_PROMPT } from "./prompts/extraction.ts";
import { validateBeerRecord } from "./validate-beer-record.ts";

const DEFAULT_BASE_URL = "https://api.minimaxi.com/anthropic";
const DEFAULT_MODEL = "MiniMax-M3";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 1;
const MAX_TOKENS = 1_024;
const EXTRACT_MANY_CONCURRENCY = 2;

export interface LlmExtractorOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class LlmExtractError extends Error {
  readonly attempts: number;
  override readonly cause: unknown;

  constructor(attempts: number, cause: unknown) {
    super(
      `LLM extraction failed after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}`,
    );
    this.name = "LlmExtractError";
    this.attempts = attempts;
    this.cause = cause;
  }
}

class LlmRequestTimeoutError extends Error {
  constructor() {
    super("LLM request timed out");
    this.name = "LlmRequestTimeoutError";
  }
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function responseText(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("LLM response must be an object");
  }

  const content = (input as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new TypeError("LLM response content must be a non-empty array");
  }

  const first = content[0];
  if (typeof first !== "object" || first === null) {
    throw new TypeError("LLM response content[0] must be an object");
  }

  const text = (first as { text?: unknown }).text;
  if (typeof text !== "string") {
    throw new TypeError("LLM response content[0].text must be a string");
  }
  return text;
}

/** Anthropic-compatible HTML-to-BeerRecord extractor. */
export class LlmExtractor {
  readonly #extractOnce: (html: string) => Promise<BeerRecord>;
  readonly #maxRetries: number;

  constructor(opts: LlmExtractorOptions) {
    if (typeof opts.apiKey !== "string" || opts.apiKey.length === 0) {
      throw new TypeError("apiKey must be a non-empty string");
    }

    const apiKey = opts.apiKey;
    const baseUrl = (
      opts.baseUrl ??
      process.env.ANTHROPIC_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/+$/, "");
    const model = opts.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
    const timeoutMs = requirePositiveInteger(
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.#maxRetries = requireNonNegativeInteger(
      opts.maxRetries ?? DEFAULT_MAX_RETRIES,
      "maxRetries",
    );

    // apiKey remains in this closure; it is never exposed as a class field or
    // included in errors/logs.
    this.#extractOnce = async (html: string): Promise<BeerRecord> => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const operation = async (): Promise<BeerRecord> => {
        const response = await globalThis.fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            model,
            max_tokens: MAX_TOKENS,
            system: BEER_RECORD_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: JSON.stringify({ html }),
              },
            ],
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`LLM endpoint returned HTTP ${response.status}`);
        }

        const payload: unknown = await response.json();
        const parsed: unknown = JSON.parse(responseText(payload));
        return validateBeerRecord(parsed);
      };

      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new LlmRequestTimeoutError());
        }, timeoutMs);
      });

      try {
        return await Promise.race([operation(), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
  }

  async extract(html: string): Promise<BeerRecord> {
    const attempts = this.#maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.#extractOnce(html);
      } catch (error) {
        lastError = error;
      }
    }

    throw new LlmExtractError(attempts, lastError);
  }

  async extractMany(
    htmls: string[],
  ): Promise<Array<BeerRecord | { error: string }>> {
    const results = new Array<BeerRecord | { error: string }>(htmls.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= htmls.length) return;

        try {
          results[index] = await this.extract(htmls[index]!);
        } catch (error) {
          results[index] = {
            error:
              error instanceof Error ? error.message : "LLM extraction failed",
          };
        }
      }
    };

    const workerCount = Math.min(EXTRACT_MANY_CONCURRENCY, htmls.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }
}
