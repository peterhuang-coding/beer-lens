// Pure functions for VQA pipeline — no I/O, fully testable.
import { createHash } from "node:crypto";
import type { CrawlItem, VqaLabels, VqaQuestion, VqaTask, ImageUrlCheck } from "./types";

// ── URL helpers ──

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    // Remove trailing slash from pathname for consistency
    u.pathname = u.pathname.replace(/\/$/, "") || "/";
    return u.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function hashKey(...parts: string[]): string {
  const input = parts.map((p) => normalizeUrl(p)).join("|");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function createTaskId(item: CrawlItem): string {
  return `vqa_${hashKey(item.sourceUrl, item.imageUrl)}`;
}

// ── HTML extraction (regex-based, no DOMParser) ──

export function extractOgTitle(html: string): string | undefined {
  // <title> tag
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (match) return decodeEntities(match[1]).trim();
  return undefined;
}

export function extractOgDescription(html: string): string | undefined {
  // og:description meta
  const match = html.match(
    /<meta\s[^>]*?(?:property\s*=\s*["']og:description["']|name\s*=\s*["']description["'])[^>]*?content\s*=\s*["']([^"']*)["'][^>]*?\/?\s*>/i,
  );
  if (match) return decodeEntities(match[1]).trim();
  // Also try standard <meta name="description">
  const alt = html.match(
    /<meta\s[^>]*?name\s*=\s*["']description["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*?\/?\s*>/i,
  );
  if (alt) return decodeEntities(alt[1]).trim();
  return undefined;
}

export function extractOgImage(html: string): string | undefined {
  const match = html.match(
    /<meta\s[^>]*?property\s*=\s*["']og:image["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*?\/?\s*>/i,
  );
  if (match) return match[1].trim();
  return undefined;
}

export function extractImgUrls(html: string, baseUrl: string): string[] {
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

/** Try to extract candidate beer names from HTML body text */
export function extractCandidateBeerNames(
  html: string,
  title?: string,
  description?: string,
): string[] {
  const names: string[] = [];
  // Strip scripts and styles
  const body = html
    .replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<[^>]*>/g, " ");

  // Beer patterns: look for known styles followed by names, or name-like patterns
  const beerStylePatterns = [
    /\b(IPA|India\s*Pale\s*Ale|Stout|Lager|Pilsner?|Sour|Porter|Wheat|Saison)\b/gi,
  ];

  // Extract visible text lines
  const lines = body
    .split(/[\n\r]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 3 && l.length < 200);

  for (const line of lines) {
    for (const pattern of beerStylePatterns) {
      if (pattern.test(line)) {
        const cleaned = decodeEntities(line).trim();
        if (!names.includes(cleaned)) {
          names.push(cleaned);
        }
        break;
      }
    }
  }

  // Limit to 10 candidates
  return names.slice(0, 10);
}

// ── HTML entity decoding ──

export function decodeEntities(text: string): string {
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

// ── Task construction ──

export function buildTaskQuestions(): VqaQuestion[] {
  return [
    {
      id: "is_beer_label",
      type: "yesno",
      prompt: "这张图是否包含啤酒瓶/罐/酒标？",
    },
    {
      id: "beer_name",
      type: "text",
      prompt: "图中最可能的啤酒名称是什么？",
    },
    {
      id: "brand",
      type: "text",
      prompt: "图中品牌是什么？",
    },
    {
      id: "style",
      type: "select",
      prompt: "能否识别风格？",
      options: ["IPA", "Stout", "Lager", "Sour", "Pilsner", "Porter", "Wheat", "Saison", "其他", "无法判断"],
    },
    {
      id: "abv",
      type: "text",
      prompt: "能否识别 ABV？",
    },
    {
      id: "visible_text",
      type: "text",
      prompt: "OCR/肉眼能看到哪些关键文字？",
    },
    {
      id: "image_quality",
      type: "select",
      prompt: "图片质量是否适合做识别测试？",
      options: ["清晰可用", "勉强可读", "模糊不清", "完全不适用"],
    },
  ];
}

export function crawlItemToVqaTask(item: CrawlItem): VqaTask {
  const now = new Date().toISOString();
  return {
    id: createTaskId(item),
    source: item.sourceName,
    sourceUrl: item.sourceUrl,
    imageUrl: item.imageUrl,
    title: item.pageTitle,
    candidateBeerName: item.candidateBeerName,
    description: item.pageDescription,
    questions: buildTaskQuestions(),
    labels: {},
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

// ── Dedup ──

export function isTaskDuplicate(
  existingTasks: VqaTask[],
  newTask: VqaTask,
): boolean {
  return existingTasks.some(
    (t) =>
      t.id === newTask.id ||
      (normalizeUrl(t.sourceUrl) === normalizeUrl(newTask.sourceUrl) &&
        normalizeUrl(t.imageUrl) === normalizeUrl(newTask.imageUrl)),
  );
}

// ── Filter / export ──

export function filterLabeledTasks(tasks: VqaTask[]): VqaTask[] {
  return tasks.filter((t) => t.status === "labeled");
}

// ── Patch validation ──

/** Allowed label field keys */
const ALLOWED_LABEL_KEYS: (keyof VqaLabels)[] = [
  "beerName",
  "brand",
  "style",
  "abv",
  "visibleText",
  "isBeerLabel",
  "imageQuality",
  "confidence",
  "notes",
];

const ALLOWED_STATUSES: VqaTask["status"][] = [
  "pending",
  "labeled",
  "skipped",
  "exported",
];

const ALLOWED_IMAGE_QUALITIES: NonNullable<VqaLabels["imageQuality"]>[] = [
  "good",
  "ok",
  "bad",
  "unusable",
];

const ALLOWED_CONFIDENCES: NonNullable<VqaLabels["confidence"]>[] = [
  "high",
  "medium",
  "low",
];

export interface PatchValidationError {
  field: string;
  message: string;
}

export function validatePatchBody(
  body: unknown,
): { valid: true; labels: VqaLabels; status?: VqaTask["status"] } | { valid: false; errors: PatchValidationError[] } {
  if (typeof body !== "object" || body === null) {
    return { valid: false, errors: [{ field: "_", message: "body must be an object" }] };
  }

  const raw = body as Record<string, unknown>;
  const errors: PatchValidationError[] = [];

  // Reject dangerous/wrong-field writes
  const dangerousFields = ["id", "sourceUrl", "imageUrl", "source", "localImagePath", "questions", "createdAt", "updatedAt"];
  for (const field of dangerousFields) {
    if (field in raw && raw[field] !== undefined) {
      errors.push({ field, message: `field "${field}" is not allowed in PATCH body` });
    }
  }

  // Reject unknown top-level keys
  const knownTopKeys = ["labels", "status"];
  for (const key of Object.keys(raw)) {
    if (!knownTopKeys.includes(key)) {
      errors.push({ field: key, message: `unknown field "${key}"` });
    }
  }

  // Validate status if present
  let status: VqaTask["status"] | undefined;
  if ("status" in raw && raw.status !== undefined) {
    if (typeof raw.status !== "string" || !ALLOWED_STATUSES.includes(raw.status as VqaTask["status"])) {
      errors.push({
        field: "status",
        message: `status must be one of: ${ALLOWED_STATUSES.join(", ")}`,
      });
    } else {
      status = raw.status as VqaTask["status"];
    }
  }

  // Validate labels if present
  const labels: VqaLabels = {};
  if ("labels" in raw && raw.labels !== undefined) {
    if (typeof raw.labels !== "object" || raw.labels === null) {
      errors.push({ field: "labels", message: "labels must be an object" });
    } else {
      const labelObj = raw.labels as Record<string, unknown>;
      for (const [key, value] of Object.entries(labelObj)) {
        if (!ALLOWED_LABEL_KEYS.includes(key as keyof VqaLabels)) {
          errors.push({ field: `labels.${key}`, message: `unknown label key: ${key}` });
          continue;
        }
        // Type validation per field
        if (
          ["beerName", "brand", "style", "abv", "visibleText", "notes"].includes(key) &&
          value !== null && value !== undefined &&
          typeof value !== "string"
        ) {
          errors.push({ field: `labels.${key}`, message: `${key} must be a string` });
          continue;
        }
        if (key === "isBeerLabel" && value !== null && value !== undefined && typeof value !== "boolean") {
          errors.push({ field: `labels.${key}`, message: "isBeerLabel must be a boolean" });
          continue;
        }
        if (key === "imageQuality" && value !== null && value !== undefined) {
          if (typeof value !== "string" || !(ALLOWED_IMAGE_QUALITIES as readonly string[]).includes(value)) {
            errors.push({
              field: `labels.${key}`,
              message: `imageQuality must be one of: ${ALLOWED_IMAGE_QUALITIES.join(", ")}`,
            });
            continue;
          }
        }
        if (key === "confidence" && value !== null && value !== undefined) {
          if (typeof value !== "string" || !(ALLOWED_CONFIDENCES as readonly string[]).includes(value)) {
            errors.push({
              field: `labels.${key}`,
              message: `confidence must be one of: ${ALLOWED_CONFIDENCES.join(", ")}`,
            });
            continue;
          }
        }
        (labels as Record<string, unknown>)[key] = value;
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, labels, status };
}

// ── Crawl dedup by (sourceUrl, imageUrl) ──

export function dedupCrawlItems(items: CrawlItem[]): CrawlItem[] {
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

// ── Regression case from labeled task ──

export function labeledTaskToRegressionCase(task: VqaTask): Record<string, unknown> | null {
  if (task.status !== "labeled") return null;
  return {
    id: task.id,
    source: "vqa-generated",
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

// ── Image URL availability check ──

export async function checkImageUrl(url: string, timeoutMs = 5000): Promise<ImageUrlCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    clearTimeout(timer);
    return {
      url,
      accessible: response.ok,
      contentType: response.headers.get("content-type") ?? undefined,
      statusCode: response.status,
    };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      url,
      accessible: false,
      error: msg,
    };
  }
}

/** Filter crawl items to only those with accessible images */
export async function filterAccessibleImages(items: CrawlItem[]): Promise<CrawlItem[]> {
  const results: CrawlItem[] = [];
  for (const item of items) {
    const check = await checkImageUrl(item.imageUrl);
    if (check.accessible) {
      results.push(item);
    }
  }
  return results;
}

// ── Build regression case for agent-regression runner ──

/** Build a batch of regression test cases suitable for run-agent-regression.mjs */
export function buildVqaRegressionCases(tasks: VqaTask[]): Record<string, unknown>[] {
  const labeled = tasks.filter(t => t.status === "labeled");
  return labeled.map((task, i) => ({
    id: `reg_vqa_${i + 1}`,
    name: task.candidateBeerName
      ? `VQA: ${task.candidateBeerName}`
      : `VQA: ${task.source} task ${i + 1}`,
    inputText: task.imageUrl,
    imagePath: task.imageUrl,
    conversationId: `vqa-regression-${i}`,
    userId: "regression-user",
    expectedIntent: "label_check",
    expectedKeywords: task.labels.beerName ? [task.labels.beerName] : undefined,
    tags: ["vqa", "label-check"],
    note: `VQA generated from ${task.source}, labeled at ${task.updatedAt}`,
  }));
}
