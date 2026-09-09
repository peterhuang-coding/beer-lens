import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("Hub serves portable data, real snapshots and correct HTTP boundaries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "beer-hub-"));
  await mkdir(path.join(root, "data/snapshots"), { recursive: true });
  await writeFile(
    path.join(root, "data/chinese-craft-beers.json"),
    JSON.stringify([{ name: "Test", brewery: "Fixture", rating: 4 }]),
  );
  await writeFile(
    path.join(root, "data/snapshots/stats-2026-01-02.json"),
    JSON.stringify({
      date: "2026-01-02",
      total_beers: 12,
      verified_entries: 3,
    }),
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
  );
  const proc = spawn(
    process.execPath,
    ["scripts/skill-hub-server.mjs", "--port", "0"],
    {
      env: { ...process.env, BEER_LENS_DATA_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let error = "";
  proc.stderr.on("data", (d) => (error += d));
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Hub startup timeout " + error)),
        8000,
      );
      proc.stdout.on("data", (d) => {
        output += d;
        const m = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      });
      proc.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(error));
      });
    });
    const stats = await (await fetch(url + "/api/stats?refresh=1")).json();
    assert.equal(stats.total_beers, 1);
    assert.equal(stats.verified_entries, 0);
    assert.deepEqual(await (await fetch(url + "/api/snapshots")).json(), [
      { date: "2026-01-02", total: 12, verified: 3 },
    ]);
    assert.deepEqual(await (await fetch(url + "/api/features")).json(), []);
    assert.deepEqual(await (await fetch(url + "/api/crawl-log")).json(), []);
    assert.equal((await fetch(url + "/")).status, 200);
    assert.equal((await fetch(url + "/data/dashboard.js")).status, 200);
    assert.equal(
      (await fetch(url + "/api/stats", { method: "POST" })).status,
      405,
    );
    assert.equal((await fetch(url + "/data/%2e%2e/package.json")).status, 404);
    await writeFile(
      path.join(root, "data/chinese-craft-beers.json"),
      "invalid",
    );
    assert.equal((await fetch(url + "/api/stats")).status, 500);
    assert.equal(
      (await (await fetch(url + "/api/health")).json()).healthy,
      false,
    );
  } finally {
    const closed = once(proc, "close");
    proc.kill();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});
