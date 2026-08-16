/**
 * Skill manifest helper — pure functions for reading / mutating
 * `data/skills/manifest.json`. Extracted into a separate module so
 * the API route and the test suite can share the same code path.
 *
 * Three responsibilities:
 *   1. readManifest(filePath)         — JSON parse from disk
 *   2. setSkillEnabled(m, id, en)     — pure: returns a new manifest with the
 *                                       target skill's `enabled` flag flipped
 *                                       and a fresh `updatedAt`.
 *   3. writeManifestAtomic(filePath, m) — atomic write: tmp file + rename.
 *                                       Protects against concurrent toggles
 *                                       overwriting each other.
 *
 * No imports from Next.js / harness router — this module is plain Node fs.
 */

import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────

export type SkillEntry = {
  id: string;
  label: string;
  description: string;
  handlerFile: string;
  preferred: string;
  enabled: boolean;
};

export type SkillManifest = {
  version: number;
  name: string;
  description: string;
  defaultEnabled: string[];
  skills: SkillEntry[];
  updatedAt?: string;
};

// ── Errors ──────────────────────────────────────────────────────────────

export class SkillNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`Skill not found: ${id}`);
    this.id = id;
    this.name = "SkillNotFoundError";
  }
}

// ── read ────────────────────────────────────────────────────────────────

/** Read and parse the manifest JSON from disk. Throws on bad JSON. */
export async function readManifest(filePath: string): Promise<SkillManifest> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as SkillManifest;
}

// ── pure transformation ─────────────────────────────────────────────────

/**
 * Return a new manifest with `skills[i].enabled` for the matching id set to
 * `enabled`. Throws SkillNotFoundError if no skill matches.
 *
 * Pure — does not touch disk. The caller passes the result to writeManifestAtomic.
 */
export function setSkillEnabled(
  manifest: SkillManifest,
  id: string,
  enabled: boolean,
): SkillManifest {
  const idx = manifest.skills.findIndex((s) => s.id === id);
  if (idx === -1) {
    throw new SkillNotFoundError(id);
  }
  // shallow-clone the top-level + skills array so we don't mutate input
  const next: SkillManifest = {
    ...manifest,
    skills: manifest.skills.map((s, i) => (i === idx ? { ...s, enabled } : s)),
    updatedAt: new Date().toISOString(),
  };
  return next;
}

// ── atomic write ────────────────────────────────────────────────────────

/**
 * Write the manifest to disk atomically:
 *   1. write  <filePath>.tmp<N>  (random N avoids cross-process clash)
 *   2. rename <filePath>.tmp<N>  →  <filePath>
 *   3. on rename failure, best-effort unlink the tmp
 *
 * `rename` is atomic on POSIX (same filesystem), so readers always see
 * either the old manifest or the new manifest — never a half-written one.
 * Concurrency: two callers doing parallel writes each produce their own
 * tmp file; the latter rename wins, but neither call loses the other's
 * intent entirely (the file is always valid JSON).
 */
export async function writeManifestAtomic(
  filePath: string,
  manifest: SkillManifest,
): Promise<void> {
  const json = JSON.stringify(manifest, null, 2) + "\n";
  // unique tmp name per call (PID + counter) so concurrent writers don't overwrite
  // each other's tmp files.
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await writeFile(tmpPath, json, "utf8");
    await rename(tmpPath, filePath);
  } catch (err) {
    // best-effort cleanup; do not mask the original error
    try {
      await unlink(tmpPath);
    } catch {
      // ignore
    }
    // ensure relative consumers (e.g. process.cwd() lookups) still work
    void dirname(filePath);
    throw err;
  }
}
