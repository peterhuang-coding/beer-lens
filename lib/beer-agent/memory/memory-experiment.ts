/**
 * Memory AB Experiment — unified utility module.
 *
 * Provides:
 *  - Config loading from pipeline-config.json
 *  - Hash-based AB split (deterministic, no crypto)
 *  - Manual override support
 *  - Memory read/write gating functions
 *
 * Backward compatible: when memoryExperiment is not configured,
 * all users get memory enabled (existing behavior).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ── Types ──

export type MemoryExperimentConfig = {
  /** Master switch — when false, memory is off for everyone */
  enabled: boolean;
  /** Whether memory READ is enabled (profile loading for recommendations) */
  memoryReadEnabled: boolean;
  /** Whether memory WRITE is enabled (episode recording, profile rebuild) */
  memoryWriteEnabled: boolean;
  /** AB mode: off=no memory, hash=deterministic split, manual=override list */
  abMode: "off" | "hash" | "manual";
  /** Ratio of users in the enabled group (0-1), used in hash mode */
  enabledRatio: number;
  /** Salt for hash to ensure different experiments have different splits */
  salt: string;
  /** Human-readable notes about the experiment */
  notes?: string;
};

const DEFAULT_CONFIG: MemoryExperimentConfig = {
  enabled: true,
  memoryReadEnabled: true,
  memoryWriteEnabled: true,
  abMode: "hash",
  enabledRatio: 0.5,
  salt: "beer-lens-memory-ab-v1",
  notes: "Default — all users get memory (backward compatible)",
};

const CONFIG_PATH = path.join(process.cwd(), "data", "pipeline-config.json");
const OVERRIDES_PATH = path.join(
  process.cwd(),
  "data",
  "memory",
  "ab-overrides.json",
);

// ── Config caching ──

let _configCache: MemoryExperimentConfig | null = null;
let _configCacheTime = 0;

/**
 * Load memory experiment config from pipeline-config.json.
 * Returns defaults when not configured (backward compatible).
 */
export async function loadMemoryExperimentConfig(): Promise<MemoryExperimentConfig> {
  if (_configCache && Date.now() - _configCacheTime < 5000) return _configCache;
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const exp = parsed.memoryExperiment;
    if (exp && typeof exp === "object") {
      _configCache = {
        enabled: exp.enabled ?? DEFAULT_CONFIG.enabled,
        memoryReadEnabled:
          exp.memoryReadEnabled ?? DEFAULT_CONFIG.memoryReadEnabled,
        memoryWriteEnabled:
          exp.memoryWriteEnabled ?? DEFAULT_CONFIG.memoryWriteEnabled,
        abMode: exp.abMode ?? DEFAULT_CONFIG.abMode,
        enabledRatio:
          typeof exp.enabledRatio === "number"
            ? exp.enabledRatio
            : DEFAULT_CONFIG.enabledRatio,
        salt: exp.salt ?? DEFAULT_CONFIG.salt,
        notes: exp.notes,
      };
    } else {
      _configCache = { ...DEFAULT_CONFIG };
    }
  } catch {
    _configCache = { ...DEFAULT_CONFIG };
  }
  _configCacheTime = Date.now();
  return _configCache;
}

// ── Hash function (pure, deterministic, no crypto) ──

/**
 * Compute a deterministic hash of a string → number in [0, 1).
 * Uses a simple polynomial rolling hash with a 31-bit prime.
 *
 * This is intentionally NOT cryptographic — it only needs to be
 * stable and evenly distributed across userIds for AB splitting.
 */
export function hashUserId(salt: string, userId: string): number {
  const input = salt + userId;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash * 31 + char) % 2147483647; // 2^31 - 1 (Mersenne prime)
  }
  return hash / 2147483647;
}

/**
 * Hash-based AB split: returns true if the user is in the enabled group.
 * Pure function — does not read config.
 */
export function isInHashGroup(
  salt: string,
  enabledRatio: number,
  userId: string,
): boolean {
  return hashUserId(salt, userId) < enabledRatio;
}

// ── Manual overrides ──

type OverrideStore = {
  updatedAt: string;
  overrides: Record<string, boolean>; // userId → enabled (true) or disabled (false)
};

let _manualOverrides: Record<string, boolean> | null = null;

async function loadOverrides(): Promise<Record<string, boolean>> {
  if (_manualOverrides) return _manualOverrides;
  try {
    const raw = await readFile(OVERRIDES_PATH, "utf8");
    const store = JSON.parse(raw) as OverrideStore;
    _manualOverrides = store.overrides ?? {};
  } catch {
    _manualOverrides = {};
  }
  return _manualOverrides;
}

async function saveOverrides(
  overrides: Record<string, boolean>,
): Promise<void> {
  _manualOverrides = { ...overrides };
  const store: OverrideStore = {
    updatedAt: new Date().toISOString(),
    overrides: _manualOverrides,
  };
  await mkdir(path.dirname(OVERRIDES_PATH), { recursive: true });
  await writeFile(
    OVERRIDES_PATH,
    JSON.stringify(store, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Set a manual override for a specific user.
 */
export async function setManualOverride(
  userId: string,
  enabled: boolean,
): Promise<void> {
  const overrides = await loadOverrides();
  overrides[userId] = enabled;
  await saveOverrides(overrides);
}

/**
 * Remove a manual override for a specific user.
 */
export async function removeManualOverride(userId: string): Promise<void> {
  const overrides = await loadOverrides();
  delete overrides[userId];
  await saveOverrides(overrides);
}

// ── Main gating functions ──

/**
 * Check whether memory READ (profile loading) is enabled for a given user.
 *
 * Resolution order:
 *  1. Config `enabled` = false → return false (master off)
 *  2. Config `abMode` = "off" → return false
 *  3. Config `abMode` = "manual" → check manual overrides, default true
 *  4. Config `abMode` = "hash" → hash-based split
 *  5. Default (no config) → return true (backward compatible)
 */
export async function isMemoryReadEnabled(userId: string): Promise<boolean> {
  const cfg = await loadMemoryExperimentConfig();

  if (!cfg.enabled) return false;
  if (!cfg.memoryReadEnabled) return false;

  switch (cfg.abMode) {
    case "off":
      return false;
    case "manual": {
      const overrides = await loadOverrides();
      if (userId in overrides) return overrides[userId];
      return true; // default enabled in manual mode
    }
    case "hash":
    default:
      return isInHashGroup(cfg.salt, cfg.enabledRatio, userId);
  }
}

/**
 * Check whether memory WRITE (episode recording, profile rebuild) is enabled
 * for a given user.
 */
export async function isMemoryWriteEnabled(userId: string): Promise<boolean> {
  const cfg = await loadMemoryExperimentConfig();

  if (!cfg.enabled) return false;
  if (!cfg.memoryWriteEnabled) return false;

  switch (cfg.abMode) {
    case "off":
      return false;
    case "manual": {
      const overrides = await loadOverrides();
      if (userId in overrides) return overrides[userId];
      return true;
    }
    case "hash":
    default:
      return isInHashGroup(cfg.salt, cfg.enabledRatio, userId);
  }
}

/**
 * Get which AB group a user belongs to.
 * Returns "enabled" or "disabled".
 */
export async function getMemoryABGroup(
  userId: string,
): Promise<"enabled" | "disabled"> {
  const enabled = await isMemoryReadEnabled(userId);
  return enabled ? "enabled" : "disabled";
}
