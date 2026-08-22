/**
 * Capability registry — declared vision tasks the app knows how to perform.
 *
 * Each capability has:
 *   - id: stable slug used by callers (`vision.call("beer_menu_image", …)`)
 *   - description: human-readable for /debug
 *   - defaultProviders: ordered fallback chain. Container walks providers
 *     in priority order; within each provider, walks models in order.
 *   - schema: best-known JSON schema (callers can override).
 *   - schemaName: OpenRouter json_schema.name (callers can override).
 *
 * Adding a new capability = `registerCapability(...)` once at module load.
 * Callers (skills) don't need to know about specific models — they pick a
 * capability and the container decides which model to use.
 */

import type { ProviderSpec } from "./types.ts";

export interface Capability {
  id: string;
  description: string;
  defaultProviders: ProviderSpec[];
  /** Default JSON schema. Callers can override per-call. */
  schema?: object;
  schemaName?: string;
}

const _registry = new Map<string, Capability>();

export function registerCapability(c: Capability): void {
  _registry.set(c.id, c);
}

export function getCapability(id: string): Capability | undefined {
  return _registry.get(id);
}

export function listCapabilities(): Capability[] {
  return Array.from(_registry.values());
}

// ── Built-in capabilities ────────────────────────────────────────────────────

/**
 * beer_menu_image — the primary vision task. Classifies a photo (menu /
 * tap_list / bottle / can / glass / venue / unknown), OCRs beers, and
 * assesses visual quality. Used by `menu_recommend` skill when the user
 * sends a photo.
 *
 * Callers MUST pass their own schema (the schema is task-specific to the
 * prompt). Default schema is left undefined.
 *
 * Provider chain (verified 2026-08-23 with the real 3-task menu prompt):
 * openrouter `qwen/qwen3-vl-32b-instruct` (primary, ~76s, reliable —
 * succeeded on every attempt) → deepseek direct
 * `deepseek-v4-flash-vision-exp` (fallback, ~68s when it works, but a
 * reasoner: on the full prompt it sometimes burns the whole max_tokens
 * budget on reasoning_content and returns empty content, which the
 * provider throws as VisionParseError → container walks to the next
 * provider). Timeouts are 120s because 45s aborted mid-request. Google/
 * GPT models on OpenRouter are 403 region-blocked here; qwen3.7-flash
 * burns its whole budget on reasoning — do NOT put either in a chain.
 */
registerCapability({
  id: "beer_menu_image",
  description:
    "Classify a beer photo + OCR beers + assess visual quality. Used by menu_recommend.",
  defaultProviders: [
    {
      provider: "openrouter",
      models: ["qwen/qwen3-vl-32b-instruct"],
      timeoutMs: 120_000,
    },
    {
      provider: "deepseek",
      models: ["deepseek-v4-flash-vision-exp"],
      timeoutMs: 120_000,
    },
  ],
  schemaName: "beer_combined_vision",
});

/**
 * beer_label_check — assess a single bottle/can label for freshness cues
 * (visible date, packaging condition). Lower-stakes, smaller image, faster.
 */
registerCapability({
  id: "beer_label_check",
  description:
    "Single-bottle/can label freshness check. Lower latency than beer_menu_image.",
  defaultProviders: [
    {
      provider: "openrouter",
      models: ["qwen/qwen3-vl-32b-instruct"],
      timeoutMs: 30_000,
    },
  ],
  schemaName: "beer_label_check",
});

/**
 * beer_photo_score — score a photo of a poured glass (oxidation / clarity /
 * foam). Diagnostic, not blocking.
 */
registerCapability({
  id: "beer_photo_score",
  description:
    "Score a photo of a poured glass for oxidation / clarity / foam signals.",
  defaultProviders: [
    {
      provider: "openrouter",
      models: ["qwen/qwen3-vl-32b-instruct"],
      timeoutMs: 30_000,
    },
  ],
  schemaName: "beer_photo_score",
});