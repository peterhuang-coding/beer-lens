import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { BeerDialogRequest, BeerDialogResponse } from "@/lib/beer-agent/dialog-types";

// Simple in-process lock to prevent concurrent writes to the same file
const writeLocks = new Map<string, Promise<void>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn even if prev rejected
  writeLocks.set(key, next.then(() => {}, () => {})); // clear lock when done (even on error)
  return next;
}

export type ShortTermMemory = {
  conversationId: string;
  userId: string;
  updatedAt: string;
  lastMenu?: {
    traceId: string;
    candidates: Array<{
      candidateId: string;
      displayName: string;
      brewery: string;
      style: string;
      abv: number;
      price?: number | null;
      rating?: number | null;
    }>;
    source: "ocr" | "text" | "manual";
    createdAt: string;
  };
  lastPicks?: {
    topPick?: { candidateId: string; label: string };
    safePick?: { candidateId: string; label: string };
    explorePick?: { candidateId: string; label: string };
    avoidOrCaution?: { candidateId: string; label: string };
  };
  activeBeer?: {
    candidateId?: string;
    displayName?: string;
    brewery?: string;
  };
  currentConstraints?: string[];
  recentTurns: Array<{
    turnId: string;
    userText: string;
    assistantReply: string;
    intent: string;
    createdAt: string;
  }>;
};

// ── Constraint keywords to extract from user text ──
const CONSTRAINT_KEYWORDS = ["清爽", "不苦", "预算", "第一杯", "配餐", "IPA", "拉格"];

/**
 * Determine the lastMenu source based on request characteristics.
 */
function determineMenuSource(request: BeerDialogRequest): "ocr" | "text" | "manual" {
  if (request.image) return "ocr";
  return "text";
}

/**
 * Extract constraint keywords present in the user text.
 */
function extractConstraints(userText: string): string[] {
  return CONSTRAINT_KEYWORDS.filter((kw) => userText.includes(kw));
}

/**
 * Resolve the canonical memory key.
 *
 * Task #6: short-term memory must be shared across channels for the same human.
 * We key by `canonicalUserId` so Web (localStorage GUID) and Feishu (mapped chatId)
 * resolve to the same file. `conversationId` is preserved on the record for audit
 * but is NOT used as the storage key.
 *
 * The Web API guarantees a non-empty `userId`. Feishu callers must supply a
 * mapped canonicalUserId through metadata. We fall back to a sanitized
 * conversationId only when neither is present so existing data files keep working.
 */
function resolveMemoryKey(canonicalUserId: string | undefined, conversationId: string): string {
  if (canonicalUserId && canonicalUserId.trim().length > 0 && canonicalUserId !== "local-user") {
    return `user_${canonicalUserId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)}`;
  }
  // Legacy / fallback: per-conversation file. Sanitize for filesystem safety.
  return `conv_${conversationId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)}`;
}

/**
 * Read short-term memory.
 *
 * @param canonicalUserId  the cross-channel user id (canonical GUID). When present,
 *                         memory is shared across Web + Feishu + future channels.
 * @param conversationId   legacy / session-scoped key. Still works as a fallback.
 */
export async function readShortTermMemory(
  conversationId: string,
  canonicalUserId?: string,
): Promise<ShortTermMemory | null> {
  const key = resolveMemoryKey(canonicalUserId, conversationId);
  const filePath = path.join(
    process.cwd(),
    "data",
    "memory",
    "short-term",
    `${key}.json`,
  );
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as ShortTermMemory;
  } catch {
    return null;
  }
}

/**
 * Update short-term memory after a dialog turn.
 * Uses an in-process lock to prevent concurrent read-modify-write races.
 */
export async function updateShortTermMemory(
  request: BeerDialogRequest,
  response: BeerDialogResponse,
): Promise<void> {
  const dirPath = path.join(process.cwd(), "data", "memory", "short-term");
  await mkdir(dirPath, { recursive: true });

  const key = resolveMemoryKey(request.userId, request.conversationId);
  const filePath = path.join(dirPath, `${key}.json`);

  // ── Lock: read + modify + write within the lock to prevent races ──
  await withLock(filePath, async () => {
    // Read existing memory or create new (inside lock!)
    let memory: ShortTermMemory;
    try {
      const raw = await readFile(filePath, "utf8");
      memory = JSON.parse(raw) as ShortTermMemory;
    } catch {
      memory = {
        conversationId: request.conversationId,
        userId: request.userId,
        updatedAt: new Date().toISOString(),
        recentTurns: [],
      };
    }

  // Always update timestamp
  memory.updatedAt = new Date().toISOString();

  // ── Update lastMenu and lastPicks if response has candidates ──
  if (response.candidates.length > 0) {
    memory.lastMenu = {
      traceId: response.traceId,
      candidates: response.candidates.map((c) => ({
        candidateId: c.candidateId,
        displayName: c.displayName,
        brewery: c.brewery,
        style: c.style,
        abv: c.abv,
        price: c.price ?? null,
        rating: c.untappdScore ?? null,
      })),
      source: determineMenuSource(request),
      createdAt: new Date().toISOString(),
    };

    memory.lastPicks = {
      topPick: {
        candidateId: response.picks.topPick.candidateId,
        label: response.picks.topPick.label,
      },
      safePick: {
        candidateId: response.picks.safePick.candidateId,
        label: response.picks.safePick.label,
      },
      explorePick: {
        candidateId: response.picks.explorePick.candidateId,
        label: response.picks.explorePick.label,
      },
      avoidOrCaution: {
        candidateId: response.picks.avoidOrCaution.candidateId,
        label: response.picks.avoidOrCaution.label,
      },
    };
  }

  // ── Update activeBeer from picks (use topPick as the active beer) ──
  if (memory.lastPicks?.topPick?.candidateId) {
    const topCandidate = response.candidates.find(
      (c) => c.candidateId === memory.lastPicks!.topPick!.candidateId,
    );
    if (topCandidate) {
      memory.activeBeer = {
        candidateId: topCandidate.candidateId,
        displayName: topCandidate.displayName,
        brewery: topCandidate.brewery,
      };
    }
  }

  // ── Extract currentConstraints from user text ──
  const lastUserText = request.messages.at(-1)?.content ?? "";
  const newConstraints = extractConstraints(lastUserText);

  if (newConstraints.length > 0) {
    // Merge with existing constraints, deduplicate
    const existing = memory.currentConstraints ?? [];
    memory.currentConstraints = [...new Set([...existing, ...newConstraints])];
  }
  // If no new constraints, keep existing ones in place (don't clear)

  // ── Append to recentTurns ──
  memory.recentTurns.push({
    turnId: response.turnId,
    userText: lastUserText,
    assistantReply: response.reply,
    intent: response.intentResult.intent,
    createdAt: new Date().toISOString(),
  });

  // Keep only the most recent 20 turns
  if (memory.recentTurns.length > 20) {
    memory.recentTurns = memory.recentTurns.slice(-20);
  }

  // ── Write back (inside the lock — no nested lock needed) ──
  await writeFile(filePath, JSON.stringify(memory, null, 2) + "\n", "utf8");
  }); // end withLock
}
