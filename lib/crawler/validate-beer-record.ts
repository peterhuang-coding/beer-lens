import type { BeerRecord } from "./contracts.ts";

const REQUIRED_FIELDS = [
  "source",
  "source_id",
  "name",
  "brewery_id",
  "style",
  "abv",
  "ibu",
  "rating",
  "rating_count",
  "description",
  "labels",
  "food_pairing",
  "similar_ids",
  "url",
  "fetched_at",
] as const satisfies ReadonlyArray<keyof BeerRecord>;

export class BeerRecordValidationError extends Error {
  readonly field: string;

  constructor(message: string, field: string) {
    super(message);
    this.name = "BeerRecordValidationError";
    this.field = field;
  }
}

function fail(field: string, message: string): never {
  throw new BeerRecordValidationError(message, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  field: keyof BeerRecord,
): void {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(field, `Field "${field}" must be a non-empty string`);
  }
}

function requireNullableString(
  record: Record<string, unknown>,
  field: keyof BeerRecord,
): void {
  const value = record[field];
  if (value !== null && (typeof value !== "string" || value.trim().length === 0)) {
    fail(field, `Field "${field}" must be null or a non-empty string`);
  }
}

function requireNullableNumber(
  record: Record<string, unknown>,
  field: keyof BeerRecord,
): void {
  const value = record[field];
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    fail(field, `Field "${field}" must be null or a finite number`);
  }
}

function requireNonEmptyStringArray(
  record: Record<string, unknown>,
  field: keyof BeerRecord,
): void {
  const value = record[field];
  if (!Array.isArray(value) || value.length === 0) {
    fail(field, `Field "${field}" must be a non-empty string array`);
  }
  if (value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    fail(field, `Field "${field}" must contain only non-empty strings`);
  }
}

/**
 * Perform the minimum runtime checks needed before an LLM response is treated
 * as the shared BeerRecord type.
 */
export function validateBeerRecord(input: unknown): BeerRecord {
  if (!isRecord(input)) {
    fail("$", "BeerRecord must be a JSON object");
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) {
      fail(field, `Missing required field "${field}"`);
    }
  }

  if (input.source !== "untappd" && input.source !== "ratebeer") {
    fail("source", 'Field "source" must be "untappd" or "ratebeer"');
  }

  for (const field of ["source_id", "name", "url", "fetched_at"] as const) {
    requireNonEmptyString(input, field);
  }

  for (const field of ["brewery_id", "style", "description"] as const) {
    requireNullableString(input, field);
  }

  for (const field of ["abv", "ibu", "rating", "rating_count"] as const) {
    requireNullableNumber(input, field);
  }

  if (
    typeof input.rating === "number" &&
    (input.rating < 0 || input.rating > 5)
  ) {
    fail("rating", 'Field "rating" must be between 0 and 5');
  }

  for (const field of ["labels", "food_pairing", "similar_ids"] as const) {
    requireNonEmptyStringArray(input, field);
  }

  return input as unknown as BeerRecord;
}
