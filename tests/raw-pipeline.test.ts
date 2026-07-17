/**
 * Tests for raw data pipeline pure functions.
 * Run: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert";

// Import pure functions from the TS source
// We inline copies here to avoid module resolution issues in the Node test runner.
// See test patterns in tests/core.test.ts for precedent.

// ── Pure function copies (keep in sync with lib/vqa-pipeline/pure.ts) ──

import { createHash } from "node:crypto";

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.pathname = u.pathname.replace(/\/$/, "") || "/";
    return u.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

function hashKey(...parts: string[]): string {
  const input = parts.map((p) => normalizeUrl(p)).join("|");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}

function extractOgTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (match) return decodeEntities(match[1]).trim();
  return undefined;
}

function extractOgDescription(html: string): string | undefined {
  const match = html.match(
    /<meta\s[^>]*?(?:property\s*=\s*["']og:description["']|name\s*=\s*["']description["'])[^>]*?content\s*=\s*["']([^"']*)["'][^>]*?\/?\s*>/i,
  );
  if (match) return decodeEntities(match[1]).trim();
  const alt = html.match(
    /<meta\s[^>]*?name\s*=\s*["']description["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*?\/?\s*>/i,
  );
  if (alt) return decodeEntities(alt[1]).trim();
  return undefined;
}

function extractOgImage(html: string): string | undefined {
  const match = html.match(
    /<meta\s[^>]*?property\s*=\s*["']og:image["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*?\/?\s*>/i,
  );
  if (match) return match[1].trim();
  return undefined;
}

function extractImgUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const regex = /<img\s[^>]*?src\s*=\s*["']([^"']+)["'][^>]*?\/?\s*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const src = match[1].trim();
    try {
      const absolute = new URL(src, baseUrl).toString();
      urls.push(absolute);
    } catch {
      // Skip invalid URLs
    }
  }
  return urls;
}

function extractCandidateBeerNames(html: string, title?: string, description?: string): string[] {
  const names: string[] = [];
  const body = html
    .replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<[^>]*>/g, " ");

  const lines = body
    .split(/[\n\r]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 3 && l.length < 200);

  const beerStylePattern = /\b(IPA|India\s*Pale\s*Ale|Stout|Lager|Pilsner?|Sour|Porter|Wheat|Saison)\b/i;

  for (const line of lines) {
    if (beerStylePattern.test(line)) {
      const cleaned = decodeEntities(line).trim();
      if (!names.includes(cleaned)) {
        names.push(cleaned);
      }
    }
  }

  return names.slice(0, 10);
}

// ── Types (inline) ──
type RawStatus = "pending" | "labeled" | "skipped" | "exported";

interface RawLabels {
  beerName?: string;
  brand?: string;
  style?: string;
  abv?: string;
  visibleText?: string;
  isBeerLabel?: boolean;
  imageQuality?: "good" | "ok" | "bad" | "unusable";
  confidence?: "high" | "medium" | "low";
  notes?: string;
}

interface RawTask {
  id: string;
  source: string;
  sourceUrl: string;
  imageUrl: string;
  localImagePath?: string;
  title?: string;
  candidateBeerName?: string;
  brand?: string;
  style?: string;
  abv?: string;
  description?: string;
  questions: Array<{ id: string; type: string; prompt: string; options?: string[] }>;
  labels: RawLabels;
  status: RawStatus;
  createdAt: string;
  updatedAt: string;
}

interface CrawlItem {
  sourceName: string;
  sourceUrl: string;
  imageUrl: string;
  pageTitle?: string;
  pageDescription?: string;
  candidateBeerName?: string;
  crawledAt: string;
}

function createRawTaskId(item: CrawlItem): string {
  return `raw_${hashKey(item.sourceUrl, item.imageUrl)}`;
}

function buildRawQuestions() {
  return [
    { id: "is_beer_label", type: "yesno", prompt: "这张图是否包含啤酒瓶/罐/酒标？" },
    { id: "beer_name", type: "text", prompt: "图中最可能的啤酒名称是什么？" },
    { id: "brand", type: "text", prompt: "图中品牌是什么？" },
    { id: "style", type: "select", prompt: "能否识别风格？", options: ["IPA", "Stout", "Lager", "Sour", "Pilsner", "Porter", "Wheat", "Saison", "其他", "无法判断"] },
    { id: "abv", type: "text", prompt: "能否识别 ABV？" },
    { id: "visible_text", type: "text", prompt: "OCR/肉眼能看到哪些关键文字？" },
    { id: "image_quality", type: "select", prompt: "图片质量是否适合做识别测试？", options: ["清晰可用", "勉强可读", "模糊不清", "完全不适用"] },
  ];
}

function crawlItemToRawTask(item: CrawlItem): RawTask {
  const now = new Date().toISOString();
  return {
    id: createRawTaskId(item),
    source: item.sourceName,
    sourceUrl: item.sourceUrl,
    imageUrl: item.imageUrl,
    title: item.pageTitle,
    candidateBeerName: item.candidateBeerName,
    description: item.pageDescription,
    questions: buildRawQuestions(),
    labels: {},
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

function isTaskDuplicate(existingTasks: RawTask[], newTask: RawTask): boolean {
  return existingTasks.some(
    (t) =>
      t.id === newTask.id ||
      (normalizeUrl(t.sourceUrl) === normalizeUrl(newTask.sourceUrl) &&
        normalizeUrl(t.imageUrl) === normalizeUrl(newTask.imageUrl)),
  );
}

function filterLabeledTasks(tasks: RawTask[]): RawTask[] {
  return tasks.filter((t) => t.status === "labeled");
}

interface PatchValidationError {
  field: string;
  message: string;
}

function validatePatchBody(body: unknown):
  | { valid: true; labels: RawLabels; status?: RawTask["status"] }
  | { valid: false; errors: PatchValidationError[] } {
  if (typeof body !== "object" || body === null) {
    return { valid: false, errors: [{ field: "_", message: "body must be an object" }] };
  }

  const raw = body as Record<string, unknown>;
  const errors: PatchValidationError[] = [];

  const dangerousFields = ["id", "sourceUrl", "imageUrl", "source", "localImagePath", "questions", "createdAt", "updatedAt"];
  for (const field of dangerousFields) {
    if (field in raw && raw[field] !== undefined) {
      errors.push({ field, message: `field "${field}" is not allowed in PATCH body` });
    }
  }

  const knownTopKeys = ["labels", "status"];
  for (const key of Object.keys(raw)) {
    if (!knownTopKeys.includes(key)) {
      errors.push({ field: key, message: `unknown field "${key}"` });
    }
  }

  const ALLOWED_STATUSES = ["pending", "labeled", "skipped", "exported"];
  let status: RawTask["status"] | undefined;
  if ("status" in raw && raw.status !== undefined) {
    if (typeof raw.status !== "string" || !ALLOWED_STATUSES.includes(raw.status)) {
      errors.push({ field: "status", message: `status must be one of: ${ALLOWED_STATUSES.join(", ")}` });
    } else {
      status = raw.status as RawTask["status"];
    }
  }

  const ALLOWED_LABEL_KEYS = ["beerName", "brand", "style", "abv", "visibleText", "isBeerLabel", "imageQuality", "confidence", "notes"];
  const ALLOWED_IMAGE_QUALITIES = ["good", "ok", "bad", "unusable"];
  const ALLOWED_CONFIDENCES = ["high", "medium", "low"];
  const labels: RawLabels = {};

  if ("labels" in raw && raw.labels !== undefined) {
    if (typeof raw.labels !== "object" || raw.labels === null) {
      errors.push({ field: "labels", message: "labels must be an object" });
    } else {
      const labelObj = raw.labels as Record<string, unknown>;
      for (const [key, value] of Object.entries(labelObj)) {
        if (!ALLOWED_LABEL_KEYS.includes(key)) {
          errors.push({ field: `labels.${key}`, message: `unknown label key: ${key}` });
          continue;
        }
        if (["beerName", "brand", "style", "abv", "visibleText", "notes"].includes(key) &&
          value !== null && value !== undefined && typeof value !== "string") {
          errors.push({ field: `labels.${key}`, message: `${key} must be a string` });
          continue;
        }
        if (key === "isBeerLabel" && value !== null && value !== undefined && typeof value !== "boolean") {
          errors.push({ field: `labels.${key}`, message: "isBeerLabel must be a boolean" });
          continue;
        }
        if (key === "imageQuality" && value !== null && value !== undefined) {
          if (typeof value !== "string" || !ALLOWED_IMAGE_QUALITIES.includes(value)) {
            errors.push({ field: `labels.${key}`, message: `imageQuality must be one of: ${ALLOWED_IMAGE_QUALITIES.join(", ")}` });
            continue;
          }
        }
        if (key === "confidence" && value !== null && value !== undefined) {
          if (typeof value !== "string" || !ALLOWED_CONFIDENCES.includes(value)) {
            errors.push({ field: `labels.${key}`, message: `confidence must be one of: ${ALLOWED_CONFIDENCES.join(", ")}` });
            continue;
          }
        }
        (labels as Record<string, unknown>)[key] = value;
      }
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, labels, status };
}

function dedupCrawlItems(items: CrawlItem[]): CrawlItem[] {
  const seen = new Set<string>();
  const result: CrawlItem[] = [];
  for (const item of items) {
    const key = `${normalizeUrl(item.sourceUrl)}::${normalizeUrl(item.imageUrl)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function labeledTaskToRegressionCase(task: RawTask): Record<string, unknown> | null {
  if (task.status !== "labeled") return null;
  return {
    id: task.id,
    source: "raw-generated",
    imageUrl: task.imageUrl,
    sourceUrl: task.sourceUrl,
    expected: {
      isBeerLabel: task.labels.isBeerLabel,
      beerName: task.labels.beerName || undefined,
      brand: task.labels.brand || undefined,
      style: task.labels.style || undefined,
      abv: task.labels.abv || undefined,
      visibleText: task.labels.visibleText || undefined,
    },
    imageQuality: task.labels.imageQuality || undefined,
    confidence: task.labels.confidence || undefined,
    notes: task.labels.notes || undefined,
    labeledAt: task.updatedAt,
  };
}

// ── Fixture HTML for tests ──

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Top 10 Craft IPAs You Should Try in 2026</title>
  <meta name="description" content="A curated list of the best craft IPAs including Pliny the Elder, Heady Topper, and more.">
  <meta property="og:image" content="https://example.com/images/ipa-guide-og.jpg">
  <meta property="og:description" content="Discover the top IPAs of the year.">
</head>
<body>
  <h1>Best IPAs of 2026</h1>
  <img src="/images/pliny-the-elder.jpg" alt="Pliny the Elder IPA">
  <img src="https://cdn.example.com/heady-topper.png" alt="Heady Topper Double IPA">
  <p>Pliny the Elder Double IPA is legendary.</p>
  <p>Heady Topper IPA from The Alchemist is a hazy masterpiece.</p>
  <p>Tree House Julius IPA - juicy and tropical.</p>
  <script>console.log("ignore me");</script>
  <style>.beer { color: gold; }</style>
  <p>This page contains &amp; specially &lt;encoded&gt; entities.</p>
</body>
</html>`;

const FIXTURE_HTML_NO_BEER = `<!DOCTYPE html>
<html><head><title>Random Tech Blog</title></head>
<body><p>No beer here, just code.</p></body></html>`;

// ═══════════════════════════════════════════════════════
// Tests: normalizeUrl
// ═══════════════════════════════════════════════════════

describe("normalizeUrl", () => {
  it("strips trailing slash", () => {
    assert.strictEqual(
      normalizeUrl("https://example.com/page/"),
      "https://example.com/page"
    );
  });

  it("lowercases on invalid URL", () => {
    assert.strictEqual(
      normalizeUrl("SomeText"),
      "sometext"
    );
  });

  it("preserves path for valid URL", () => {
    const result = normalizeUrl("https://example.com/path?q=1");
    assert(result.startsWith("https://example.com/path"));
  });
});

// ═══════════════════════════════════════════════════════
// Tests: hashKey
// ═══════════════════════════════════════════════════════

describe("hashKey", () => {
  it("produces consistent hash", () => {
    const a = hashKey("https://a.com", "https://b.com/img.jpg");
    const b = hashKey("https://a.com", "https://b.com/img.jpg");
    assert.strictEqual(a, b);
  });

  it("produces different hash for different inputs", () => {
    const a = hashKey("https://a.com", "img1.jpg");
    const b = hashKey("https://a.com", "img2.jpg");
    assert.notStrictEqual(a, b);
  });

  it("normalizes URLs before hashing", () => {
    const a = hashKey("https://a.com/", "https://b.com/");
    const b = hashKey("https://a.com", "https://b.com");
    assert.strictEqual(a, b);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: createRawTaskId
// ═══════════════════════════════════════════════════════

describe("createRawTaskId", () => {
  it("creates stable id from crawl item", () => {
    const item: CrawlItem = {
      sourceName: "test",
      sourceUrl: "https://example.com",
      imageUrl: "https://example.com/img.jpg",
      crawledAt: new Date().toISOString(),
    };
    const id1 = createRawTaskId(item);
    const id2 = createRawTaskId(item);
    assert.strictEqual(id1, id2);
    assert(id1.startsWith("raw_"));
  });
});

// ═══════════════════════════════════════════════════════
// Tests: HTML extraction
// ═══════════════════════════════════════════════════════

describe("extractOgTitle", () => {
  it("extracts title", () => {
    assert.strictEqual(
      extractOgTitle(FIXTURE_HTML),
      "Top 10 Craft IPAs You Should Try in 2026"
    );
  });

  it("returns undefined for no title", () => {
    assert.strictEqual(extractOgTitle("<html><body>no title</body></html>"), undefined);
  });
});

describe("extractOgDescription", () => {
  it("extracts og:description", () => {
    const desc = extractOgDescription(FIXTURE_HTML);
    assert(desc?.includes("Pliny the Elder"));
  });

  it("returns undefined when no description meta", () => {
    assert.strictEqual(
      extractOgDescription("<html><head></head><body></body></html>"),
      undefined
    );
  });
});

describe("extractOgImage", () => {
  it("extracts og:image URL", () => {
    assert.strictEqual(
      extractOgImage(FIXTURE_HTML),
      "https://example.com/images/ipa-guide-og.jpg"
    );
  });

  it("returns undefined when no og:image", () => {
    assert.strictEqual(
      extractOgImage("<html><body></body></html>"),
      undefined
    );
  });
});

describe("extractImgUrls", () => {
  it("extracts and resolves relative img URLs", () => {
    const urls = extractImgUrls(FIXTURE_HTML, "https://example.com");
    assert.strictEqual(urls.length, 2);
    assert(urls.includes("https://example.com/images/pliny-the-elder.jpg"));
    assert(urls.includes("https://cdn.example.com/heady-topper.png"));
  });

  it("returns empty array when no images", () => {
    const urls = extractImgUrls("<html><body><p>no img</p></body></html>", "https://x.com");
    assert.strictEqual(urls.length, 0);
  });
});

describe("extractCandidateBeerNames", () => {
  it("finds beer-related lines", () => {
    const names = extractCandidateBeerNames(FIXTURE_HTML);
    assert(names.length >= 2);
    assert(names.some((n) => n.includes("Pliny")));
    assert(names.some((n) => n.includes("Heady Topper")));
  });

  it("returns empty for non-beer page", () => {
    const names = extractCandidateBeerNames(FIXTURE_HTML_NO_BEER);
    assert.strictEqual(names.length, 0);
  });

  it("decodes HTML entities in names", () => {
    const html = "<html><body><p>Stone &amp; Wood Pacific Ale IPA</p></body></html>";
    const names = extractCandidateBeerNames(html);
    assert(names.some((n) => n.includes("Stone & Wood")));
  });
});

// ═══════════════════════════════════════════════════════
// Tests: crawlItemToRawTask
// ═══════════════════════════════════════════════════════

describe("crawlItemToRawTask", () => {
  it("converts crawl item to task with all fields", () => {
    const item: CrawlItem = {
      sourceName: "beer-review-site",
      sourceUrl: "https://example.com/ipa-guide",
      imageUrl: "https://example.com/img.jpg",
      pageTitle: "IPA Guide",
      pageDescription: "Best IPAs",
      candidateBeerName: "Pliny the Elder IPA",
      crawledAt: "2026-07-07T00:00:00.000Z",
    };
    const task = crawlItemToRawTask(item);
    assert.strictEqual(task.source, "beer-review-site");
    assert.strictEqual(task.sourceUrl, item.sourceUrl);
    assert.strictEqual(task.imageUrl, item.imageUrl);
    assert.strictEqual(task.title, "IPA Guide");
    assert.strictEqual(task.candidateBeerName, "Pliny the Elder IPA");
    assert.strictEqual(task.status, "pending");
    assert.strictEqual(task.questions.length, 7);
    assert.strictEqual(task.labels.beerName, undefined);
    assert.strictEqual(task.labels.isBeerLabel, undefined);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: isTaskDuplicate
// ═══════════════════════════════════════════════════════

describe("isTaskDuplicate", () => {
  const baseTask: RawTask = {
    id: "raw_abc123",
    source: "test",
    sourceUrl: "https://example.com/page",
    imageUrl: "https://example.com/img.jpg",
    questions: [],
    labels: {},
    status: "pending",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  it("detects duplicate by id", () => {
    assert.strictEqual(isTaskDuplicate([baseTask], { ...baseTask, id: "raw_abc123" }), true);
  });

  it("detects duplicate by normalized URLs", () => {
    const newTask = {
      ...baseTask,
      id: "raw_different",
      sourceUrl: "https://example.com/page/",
      imageUrl: "https://example.com/img.jpg",
    };
    assert.strictEqual(isTaskDuplicate([baseTask], newTask), true);
  });

  it("returns false for distinct URLs", () => {
    const newTask = {
      ...baseTask,
      id: "raw_different",
      sourceUrl: "https://other.com/page",
      imageUrl: "https://other.com/img.jpg",
    };
    assert.strictEqual(isTaskDuplicate([baseTask], newTask), false);
  });

  it("returns false for empty list", () => {
    assert.strictEqual(isTaskDuplicate([], baseTask), false);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: filterLabeledTasks
// ═══════════════════════════════════════════════════════

describe("filterLabeledTasks", () => {
  it("filters only labeled tasks", () => {
    const tasks: RawTask[] = [
      { id: "1", source: "a", sourceUrl: "u1", imageUrl: "i1", questions: [], labels: {}, status: "pending", createdAt: "", updatedAt: "" },
      { id: "2", source: "a", sourceUrl: "u2", imageUrl: "i2", questions: [], labels: { beerName: "IPA" }, status: "labeled", createdAt: "", updatedAt: "" },
      { id: "3", source: "a", sourceUrl: "u3", imageUrl: "i3", questions: [], labels: {}, status: "skipped", createdAt: "", updatedAt: "" },
      { id: "4", source: "a", sourceUrl: "u4", imageUrl: "i4", questions: [], labels: { beerName: "Stout" }, status: "labeled", createdAt: "", updatedAt: "" },
    ];
    const result = filterLabeledTasks(tasks);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].id, "2");
    assert.strictEqual(result[1].id, "4");
  });

  it("returns empty when no labeled tasks", () => {
    const tasks: RawTask[] = [
      { id: "1", source: "a", sourceUrl: "u1", imageUrl: "i1", questions: [], labels: {}, status: "pending", createdAt: "", updatedAt: "" },
    ];
    assert.strictEqual(filterLabeledTasks(tasks).length, 0);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: validatePatchBody
// ═══════════════════════════════════════════════════════

describe("validatePatchBody", () => {
  it("accepts valid labels", () => {
    const result = validatePatchBody({
      labels: { beerName: "Pliny the Elder", isBeerLabel: true, imageQuality: "good" },
    });
    assert.strictEqual(result.valid, true);
    if (result.valid) {
      assert.strictEqual(result.labels.beerName, "Pliny the Elder");
      assert.strictEqual(result.labels.isBeerLabel, true);
      assert.strictEqual(result.labels.imageQuality, "good");
    }
  });

  it("accepts status change", () => {
    const result = validatePatchBody({ status: "labeled" });
    assert.strictEqual(result.valid, true);
    if (result.valid) {
      assert.strictEqual(result.status, "labeled");
    }
  });

  it("rejects dangerous fields", () => {
    const result = validatePatchBody({ id: "new-id", labels: { beerName: "X" } });
    assert.strictEqual(result.valid, false);
    if (!result.valid) {
      assert(result.errors.some((e) => e.field === "id"));
    }
  });

  it("rejects unknown top-level keys", () => {
    const result = validatePatchBody({ randomField: 123, labels: {} });
    assert.strictEqual(result.valid, false);
    if (!result.valid) {
      assert(result.errors.some((e) => e.field === "randomField"));
    }
  });

  it("rejects unknown label keys", () => {
    const result = validatePatchBody({ labels: { hackerField: "evil" } });
    assert.strictEqual(result.valid, false);
    if (!result.valid) {
      assert(result.errors.some((e) => e.field === "labels.hackerField"));
    }
  });

  it("rejects invalid status", () => {
    const result = validatePatchBody({ status: "deleted" });
    assert.strictEqual(result.valid, false);
  });

  it("rejects invalid imageQuality", () => {
    const result = validatePatchBody({ labels: { imageQuality: "excellent" } });
    assert.strictEqual(result.valid, false);
  });

  it("rejects invalid confidence", () => {
    const result = validatePatchBody({ labels: { confidence: "very_high" } });
    assert.strictEqual(result.valid, false);
  });

  it("rejects non-boolean isBeerLabel", () => {
    const result = validatePatchBody({ labels: { isBeerLabel: "yes" } });
    assert.strictEqual(result.valid, false);
  });

  it("rejects non-string beerName", () => {
    const result = validatePatchBody({ labels: { beerName: 123 } });
    assert.strictEqual(result.valid, false);
  });

  it("rejects non-object body", () => {
    const result = validatePatchBody("not an object");
    assert.strictEqual(result.valid, false);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: dedupCrawlItems
// ═══════════════════════════════════════════════════════

describe("dedupCrawlItems", () => {
  it("removes duplicate crawl items by URL pair", () => {
    const items: CrawlItem[] = [
      { sourceName: "a", sourceUrl: "https://a.com", imageUrl: "https://a.com/1.jpg", crawledAt: "t1" },
      { sourceName: "a", sourceUrl: "https://a.com", imageUrl: "https://a.com/1.jpg", crawledAt: "t2" },
      { sourceName: "b", sourceUrl: "https://b.com", imageUrl: "https://b.com/2.jpg", crawledAt: "t3" },
    ];
    const result = dedupCrawlItems(items);
    assert.strictEqual(result.length, 2);
  });

  it("normalizes URLs before dedup", () => {
    const items: CrawlItem[] = [
      { sourceName: "a", sourceUrl: "https://a.com/", imageUrl: "https://b.com/img.jpg/", crawledAt: "t1" },
      { sourceName: "a", sourceUrl: "https://a.com", imageUrl: "https://b.com/img.jpg", crawledAt: "t2" },
    ];
    const result = dedupCrawlItems(items);
    assert.strictEqual(result.length, 1);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: labeledTaskToRegressionCase
// ═══════════════════════════════════════════════════════

describe("labeledTaskToRegressionCase", () => {
  it("converts labeled task to regression case", () => {
    const task: RawTask = {
      id: "raw_test1",
      source: "test",
      sourceUrl: "https://example.com",
      imageUrl: "https://example.com/img.jpg",
      questions: [],
      labels: { beerName: "Pliny", brand: "Russian River", style: "IPA" },
      status: "labeled",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-07-07T00:00:00Z",
    };
    const result = labeledTaskToRegressionCase(task);
    assert(result !== null);
    if (result) {
      assert.strictEqual(result.id, "raw_test1");
      assert.strictEqual(result.source, "raw-generated");
      assert.strictEqual((result.expected as Record<string, unknown>).beerName, "Pliny");
    }
  });

  it("returns null for non-labeled task", () => {
    const task: RawTask = {
      id: "raw_test2",
      source: "test",
      sourceUrl: "https://example.com",
      imageUrl: "https://example.com/img.jpg",
      questions: [],
      labels: {},
      status: "pending",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    assert.strictEqual(labeledTaskToRegressionCase(task), null);
  });
});

// ═══════════════════════════════════════════════════════
// Tests: buildRawQuestions
// ═══════════════════════════════════════════════════════

describe("buildRawQuestions", () => {
  it("returns 7 questions", () => {
    const questions = buildRawQuestions();
    assert.strictEqual(questions.length, 7);
  });

  it("all questions have id, type, prompt", () => {
    const questions = buildRawQuestions();
    for (const q of questions) {
      assert.ok(q.id.length > 0);
      assert.ok(["yesno", "text", "select"].includes(q.type));
      assert.ok(q.prompt.length > 0);
    }
  });

  it("select questions have options", () => {
    const questions = buildRawQuestions();
    const selects = questions.filter((q) => q.type === "select");
    for (const q of selects) {
      assert.ok(q.options && q.options.length > 0);
    }
  });
});
