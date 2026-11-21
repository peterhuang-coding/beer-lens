import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

type CachedJson = {
  signature: string;
  value: unknown;
};

const cache = new Map<string, CachedJson>();
const MAX_FILES = 64;

function signature(stats: Stats): string {
  return [stats.mtimeMs, stats.ctimeMs, stats.size, stats.ino].join(":");
}

/**
 * Cache small, fixed JSON assets by absolute path. ctime/ino complement
 * mtime+size so same-length rewrites with restored mtimes cannot stay stale.
 */
export async function readCachedJson<T>(
  filePath: string,
  transform: (parsed: unknown) => T,
): Promise<T> {
  const absolutePath = path.resolve(filePath);
  let before: Stats;
  try {
    before = await stat(absolutePath);
  } catch (error) {
    cache.delete(absolutePath);
    throw error;
  }

  const beforeSignature = signature(before);
  const cached = cache.get(absolutePath);
  if (cached?.signature === beforeSignature) {
    return structuredClone(cached.value) as T;
  }

  try {
    const raw = await readFile(absolutePath, "utf8");
    const value = transform(JSON.parse(raw));
    const afterSignature = signature(await stat(absolutePath));
    if (afterSignature === beforeSignature) {
      if (cache.size >= MAX_FILES) cache.delete(cache.keys().next().value!);
      cache.set(absolutePath, { signature: afterSignature, value });
    }
    // Keep the cached object isolated from grounding code and external callers.
    return structuredClone(value);
  } catch (error) {
    cache.delete(absolutePath);
    throw error;
  }
}
