/**
 * POST /api/skills/[id]/toggle
 *
 * Flips the `enabled` flag for the given skill in `data/skills/manifest.json`
 * and writes the change back atomically. The harness router at
 * `lib/harness/router.ts` already honours `skill.enabled` at dispatch time,
 * so this endpoint is the runtime kill-switch for a skill without redeploy.
 *
 * Response:
 *   200 { id, enabled }                         — success
 *   404 { error: "skill not found" }            — unknown id
 *   500 { error: "<message>" }                  — any I/O / parse failure
 *
 * The endpoint is read-modify-write: it reads the current manifest, flips
 * the boolean, then writes atomically. Two callers racing each other will
 * both produce valid JSON (the rename is the atomic point), so the worst
 * case is "last write wins" — never a corrupt file.
 */

import { NextResponse } from "next/server";
import { join } from "node:path";
import {
  readManifest,
  setSkillEnabled,
  writeManifestAtomic,
  SkillNotFoundError,
} from "@/lib/skills/manifest-helper";

export const runtime = "nodejs";

function manifestPath(): string {
  // process.cwd() at the Next.js server = repo root
  return join(process.cwd(), "data", "skills", "manifest.json");
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const filePath = manifestPath();
    const current = await readManifest(filePath);
    const next = setSkillEnabled(current, id, !current.skills.find((s) => s.id === id)?.enabled);
    await writeManifestAtomic(filePath, next);
    const entry = next.skills.find((s) => s.id === id)!;
    return NextResponse.json({ id: entry.id, enabled: entry.enabled });
  } catch (err) {
    if (err instanceof SkillNotFoundError) {
      return NextResponse.json({ error: "skill not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
