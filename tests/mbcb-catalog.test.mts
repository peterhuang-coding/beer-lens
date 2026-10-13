import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { handleMbcbQuery } from "../lib/feishu/mbcb.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "mbcb-catalog.py");
const SAMPLE = path.join(ROOT, "tests", "fixtures", "mbcb-red-sample.json");

interface BeerRecord {
  event_id: string;
  event_beer_id: number;
  name: string;
  name_zh: string | null;
  brewery: string;
  brewery_zh: string | null;
  sessions: string[];
  style: string | null;
  abv: number | null;
  description: string | null;
  untappd_id: number | null;
  rating_raw: number | null;
  rating_count: number | null;
  rating_usable: boolean;
  source_url: string | null;
  retrieved_at: string | null;
  issues: string[];
  missing_fields: string[];
  aliases: string[];
  description_zh: string | null;
  description_zh_review_status: string;
  [k: string]: unknown;
}

function record(eid: number, over: Partial<BeerRecord> = {}): BeerRecord {
  return {
    event_id: "mbcb-2026-beijing",
    event_beer_id: eid,
    name: `Beer ${eid}`,
    name_zh: null,
    brewery: "Some Brewery",
    brewery_zh: null,
    sessions: ["red"],
    style: "Ale",
    abv: 5,
    description: `description ${eid}`,
    untappd_id: 1000 + eid,
    rating_raw: 4.01,
    rating_count: 11,
    rating_usable: true,
    source_url: "https://example.com/latest.json",
    retrieved_at: "2026-10-12T00:00:00+00:00",
    issues: [],
    missing_fields: [],
    aliases: [],
    description_zh: null,
    description_zh_review_status: "no_source",
    ...over,
  };
}

function runPy(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("python3", [SCRIPT, ...args], { cwd: ROOT }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      if (e && e.code === "ENOENT") {
        reject(err);
        return;
      }
      const code = e && typeof e.code === "number" ? e.code : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

const tmpDirs: string[] = [];

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbcb-node-"));
  tmpDirs.push(dir);
  return path.join(dir, "beer.db");
}

function importRecords(db: string, records: BeerRecord[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = path.dirname(db);
  const jsonPath = path.join(dir, `batch-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(records), "utf-8");
  return runPy(["--db", db, "--import", jsonPath]);
}

const sampleRecords = JSON.parse(fs.readFileSync(SAMPLE, "utf-8")) as BeerRecord[];

describe("handleMbcbQuery via real python + temp sqlite", () => {
  const db = makeTempDb();

  before(async () => {
    const r = await importRecords(db, sampleRecords);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).imported, 4);
  });

  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it("non-commands return null so ordinary chat is untouched", async () => {
    for (const text of [
      "今天想喝点什么",
      "recommend me a beer",
      "/mbcbxxx Helles",
      "MBCB 第三场 Helles",
      "see /mbcb later",
      "",
    ]) {
      assert.equal(await handleMbcbQuery(text, { dbPath: db }), null, JSON.stringify(text));
    }
  });

  it("/mbcb alone lists 20 with #ids, names, breweries and total", async () => {
    const reply = await handleMbcbQuery("/mbcb", { dbPath: db });
    assert.ok(reply);
    assert.match(reply, /共 4 款/);
    assert.match(reply, /#498/);
    assert.match(reply, /Mikkeller Ice Tea Powered by Longfong/);
    assert.match(reply, /#424/);
    assert.match(reply, /Adroit Theory/);
    assert.match(reply, /#96/);
    assert.match(reply, /3 Sons/);
    assert.match(reply, /#599/);
    // listing never dumps descriptions
    assert.doesNotMatch(reply, /conditioned it on Rosemary/);
  });

  it("unique #id shows source-grounded detail incl resolved zh paraphrase and conflict", async () => {
    const reply = await handleMbcbQuery("/mbcb #424", { dbPath: db });
    assert.ok(reply);
    assert.match(reply, /#424/);
    assert.match(reply, /Gose/);
    assert.match(reply, /4\.5%/);
    assert.match(reply, /冲突|未解决/); // ABV conflict visible, no winner
    assert.match(reply, /4\.09/); // usable rating rounded
    assert.match(reply, /369/);
    assert.match(reply, /迷迭香/); // spotchecked zh paraphrase allowed
    assert.match(reply, /https:\/\/mbcb\.jonpacker\.com\/latest\.json/);
    assert.match(reply, /2026-10-12T16:36:40/);
    assert.match(reply, /red/);
    assert.match(reply, /Rosemary's Baby/); // alias
    assert.match(reply, /abv_database_disagreement/);
    // never invents price/volume/stock values (the "not provided" caveat is fine)
    assert.doesNotMatch(reply, /[￥¥$]\s*\d|\d+\s*元|\bRMB\b|\bCNY\b/);
  });

  it("ice tea: unknown abv is 未知 not 0%, no fabricated description", async () => {
    const reply = await handleMbcbQuery("/mbcb #498", { dbPath: db });
    assert.ok(reply);
    assert.match(reply, /#498/);
    assert.match(reply, /Ice Tea/);
    assert.match(reply, /ABV：未知/);
    assert.match(reply, /风格：未知/);
    assert.match(reply, /暂无可用评分/);
    assert.match(reply, /来源未提供简介|无来源/);
  });

  it("pending_review chinese paraphrase is never shown; english description is", async () => {
    const pendingDb = makeTempDb();
    const pending = record(700, {
      name: "Pending Translation Beer",
      untappd_id: 7007001,
      abv: 6.1,
      description: "PENDING ENGLISH DESC SOURCE",
      description_zh: "PENDING_ZH_SECRET 未审核",
      description_zh_review_status: "pending_review",
    });
    const r = await importRecords(pendingDb, [pending]);
    assert.equal(r.code, 0, r.stderr);
    const reply = await handleMbcbQuery("/mbcb #700", { dbPath: pendingDb });
    assert.ok(reply);
    assert.match(reply, /PENDING ENGLISH DESC SOURCE/);
    assert.doesNotMatch(reply, /PENDING_ZH_SECRET/);
  });

  it("ambiguous name lists candidates with both breweries, never picks a winner", async () => {
    const reply = await handleMbcbQuery("/mbcb Helles", { dbPath: db });
    assert.ok(reply);
    assert.match(reply, /候选/);
    assert.match(reply, /#96[\s\S]*3 Sons/);
    assert.match(reply, /#599[\s\S]*Wagner Merkendorf/);
  });

  it("brewery + english name disambiguates to a single id", async () => {
    const a = await handleMbcbQuery("/mbcb 3 Sons Helles", { dbPath: db });
    assert.ok(a);
    assert.match(a, /#96/);
    assert.doesNotMatch(a.replace(/#599/g, ""), /#59/);
    assert.match(a, /German style Helles/);
    const b = await handleMbcbQuery("/mbcb Wagner Merkendorf Helles", { dbPath: db });
    assert.ok(b);
    assert.match(b, /#599/);
    assert.doesNotMatch(b, /#96/);
    // unrelated brewery tokens cannot combine across records
    const none = await handleMbcbQuery("/mbcb Wagner Sons Helles", { dbPath: db });
    assert.ok(none);
    assert.match(none, /没有找到|未找到/);
  });

  it("chinese brewery/name and untappd numeric queries resolve", async () => {
    assert.match((await handleMbcbQuery("/mbcb 美奇乐", { dbPath: db })) ?? "", /#498/);
    assert.match((await handleMbcbQuery("/mbcb 智理宝贝", { dbPath: db })) ?? "", /#424/);
    assert.match((await handleMbcbQuery("/mbcb 5847116", { dbPath: db })) ?? "", /#96/);
  });

  it("accepts MBCB 第二场 / 鼠场 prefixes and 第N页 paging tokens", async () => {
    assert.match((await handleMbcbQuery("MBCB 第二场 #424", { dbPath: db })) ?? "", /Gose/);
    assert.match((await handleMbcbQuery("mbcb 鼠场 Helles", { dbPath: db })) ?? "", /候选/);
  });

  it("paginates with 第N页 over a 25-record synthetic catalog", async () => {
    const pdb = makeTempDb();
    const recs = Array.from({ length: 25 }, (_, i) => record(i + 1, { name: `Pager ${i + 1}` }));
    const r = await importRecords(pdb, recs);
    assert.equal(r.code, 0, r.stderr);
    const p1 = await handleMbcbQuery("/mbcb", { dbPath: pdb });
    assert.ok(p1);
    assert.match(p1, /共 25 款/);
    assert.match(p1, /第 1 页/);
    assert.equal((p1.match(/^#\d+/gm) ?? []).length, 20);
    const p2 = await handleMbcbQuery("/mbcb 第2页", { dbPath: pdb });
    assert.ok(p2);
    assert.match(p2, /第 2 页/);
    assert.equal((p2.match(/^#\d+/gm) ?? []).length, 5);
  });

  it("last page of ambiguous search remains candidates, never a unique match", async () => {
    const pdb = makeTempDb();
    const recs = Array.from({ length: 21 }, (_, i) => record(i + 1, { name: `Pager ${i + 1}` }));
    assert.equal((await importRecords(pdb, recs)).code, 0);
    const reply = await handleMbcbQuery("/mbcb Pager 第2页", { dbPath: pdb });
    assert.match(reply ?? "", /21 个候选/);
    assert.match(reply ?? "", /#21/);
    assert.doesNotMatch(reply ?? "", /ABV：/);
    const beyond = await handleMbcbQuery("/mbcb Pager 第3页", { dbPath: pdb });
    assert.match(beyond ?? "", /超出/);
  });

  it("re-import is idempotent: no duplicate lines", async () => {
    const idb = makeTempDb();
    await importRecords(idb, sampleRecords);
    const second = await importRecords(idb, sampleRecords);
    assert.equal(second.code, 0, second.stderr);
    const reply = await handleMbcbQuery("/mbcb", { dbPath: idb });
    assert.ok(reply);
    assert.match(reply, /共 4 款/);
    assert.equal((reply.match(/#424/g) ?? []).length, 1);
  });

  it("missing db yields a usable unavailable message without leaking internals", async () => {
    const reply = await handleMbcbQuery("/mbcb Helles", {
      dbPath: path.join(makeTempDb(), "does-not-exist.db"),
    });
    assert.ok(reply);
    assert.match(reply, /不可用|未就绪|尚未导入/);
    assert.doesNotMatch(reply, /Traceback|sqlite3|OperationalError|\.db/);
  });

  it("unknown query gives a zero-result hint, not fabricated facts", async () => {
    const reply = await handleMbcbQuery("/mbcb zzz-no-beer-zzz", { dbPath: db });
    assert.ok(reply);
    assert.match(reply, /没有找到|未找到/);
    assert.match(reply, /#编号/);
  });
});
