import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["lib", "scripts", "tests", "data/crawler", "docs"];
const CREDENTIAL_ENV_NAME = ["MINIMAX", "API", "KEY"].join("_");

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function filesBelow(directory: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return filesBelow(entryPath);
      return entry.isFile() ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

test("credential identifier is absent except for explicit environment reads", async () => {
  const files = (
    await Promise.all(SCAN_DIRS.map((dir) => filesBelow(path.join(ROOT, dir))))
  ).flat();
  const allowedEnvironmentRead = `process.env.${CREDENTIAL_ENV_NAME}`;
  const violations: string[] = [];

  for (const file of files) {
    const contents = await fs.readFile(file, "utf8");
    const withoutAllowedReads = contents.split(allowedEnvironmentRead).join("");
    if (withoutAllowedReads.includes(CREDENTIAL_ENV_NAME)) {
      violations.push(path.relative(ROOT, file));
    }
  }

  assert.deepEqual(
    violations,
    [],
    `credential identifier leaked outside environment reads: ${violations.join(", ")}`,
  );
});
