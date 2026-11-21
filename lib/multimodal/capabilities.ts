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
 * Provider chain: openrouter `qwen/qwen3-vl-32b-instruct` (primary) →
 * DeepSeek direct `deepseek-flash` (fallback). The stable DeepSeek alias
 * comes from official documentation checked 2026-10-28. Historical latency
 * and empty-content observations from 2026-08 used the retired experimental
 * alias and are not performance evidence for the current model. Google/GPT
 * models on OpenRouter were region-blocked in this environment; qwen3.7-flash
 * burned its whole budget on reasoning — do NOT put either in this chain.
 *
 * 2026-08-28: qwen3-vl-32b 在 120s 内仍出现 TIM(菜单图 ~1.3MB,大图链路慢),
 * 提到 180s 减抖动;deepseek 兜底同提,防止主模型超时后兜底也顶到上限。
 */
registerCapability({
  id: "beer_menu_image",
  description:
    "Classify a beer photo + OCR beers + assess visual quality. Used by menu_recommend.",
  defaultProviders: [
    {
      provider: "openrouter",
      models: ["qwen/qwen3-vl-32b-instruct"],
      timeoutMs: 180_000,
    },
    {
      provider: "deepseek",
      models: ["deepseek-flash"],
      timeoutMs: 180_000,
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