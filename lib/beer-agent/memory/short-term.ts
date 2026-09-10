import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BeerCandidate } from "../types.ts";
import { extractConstraints, mergeConstraints } from "../recommendation/constraints.ts";
import { parseMenuInput, hasNamedMenuItems } from "../recommendation/menu-input.ts";
import type { BeerDialogRequest, BeerDialogResponse } from "@/lib/beer-agent/dialog-types";
import { traceMemoryRead, traceMemoryWrite } from "./with-trace.ts";

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
    candidates: Array<BeerCandidate & { rating?: number | null; ratingsCount?: number | null }>;
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

function determineMenuSource(request: BeerDialogRequest): "ocr" | "text" | "manual" {
  return request.image ? "ocr" : "text";
}

/** Active menus belong to a user AND conversation; long-term profiles remain user scoped.
 * Hash full IDs so punctuation and long identifiers cannot collide after sanitizing.
 * Old user-only files are deliberately not read into new conversations.
 */
function resolveMemoryKey(canonicalUserId: string | undefined, conversationId: string): string {
  const identity = JSON.stringify([canonicalUserId || "anonymous", conversationId]);
  return `session_${createHash("sha256").update(identity).digest("hex")}`;
}

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
    const parsed = JSON.parse(raw) as ShortTermMemory;
    traceMemoryRead({
      kind: "short_term",
      key,
      found: true,
      last_menu_candidate_count: parsed.lastMenu?.candidates.length ?? 0,
      recent_turns: parsed.recentTurns?.length ?? 0,
    });
    return parsed;
  } catch {
    traceMemoryRead({ kind: "short_term", key, found: false });
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

  const lastUserText = request.messages.at(-1)?.content ?? "";
  const parsedInput = parseMenuInput(lastUserText);
  const newMenu = !!request.image || parsedInput.isMenu || (response.intentResult.intent === "menu_recommend" && hasNamedMenuItems(parsedInput.items));
  // Keep the full menu when filtering. An explicitly new empty menu clears stale context.
  if (newMenu || response.candidates.length > 0) {
    memory.lastMenu = {
      traceId: response.traceId,
      candidates: response.candidates.map((c) => ({
        ...c,
        rating: c.untappdScore ?? null,
        ratingsCount: c.untappdRatingCount ?? null,
        sourceRiskFlags: c.sourceRiskFlags ?? c.riskFlags ?? [],
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

  if (newMenu || response.candidates.length > 0) delete memory.activeBeer;

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

  const newConstraints = extractConstraints(newMenu && hasNamedMenuItems(parsedInput.items) ? parsedInput.requestText : lastUserText);
  memory.currentConstraints = mergeConstraints(newMenu ? [] : memory.currentConstraints ?? [], newConstraints);

  // ── Append to recentTurns ──
  memory.recentTurns.push({
    turnId: response.turnId || request.turnId,
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
  const writeStartedAt = Date.now();
  const bytes = JSON.stringify(memory, null, 2).length + 1;
  try {
    await writeFile(filePath, JSON.stringify(memory, null, 2) + "\n", "utf8");
    traceMemoryWrite({
      kind: "short_term",
      key: resolveMemoryKey(request.userId, request.conversationId),
      write_size_bytes: bytes,
      candidates_written: memory.lastMenu?.candidates.length ?? 0,
    });
  } catch (err) {
    traceMemoryWrite({
      kind: "short_term",
      key: resolveMemoryKey(request.userId, request.conversationId),
      error: String((err as Error).message ?? err).slice(0, 200),
    }, false);
    throw err;
  }
  }); // end withLock
}

/** A newly supplied menu invalidates the active one even if its analysis fails. */
export async function clearShortTermMenu(conversationId: string, userId: string): Promise<void> {
  const filePath = path.join(process.cwd(), 'data/memory/short-term', `${resolveMemoryKey(userId,conversationId)}.json`);
  await withLock(filePath, async()=>{
    let memory:ShortTermMemory;
    try { memory=JSON.parse(await readFile(filePath,'utf8')); } catch(err) {
      if ((err as NodeJS.ErrnoException).code==='ENOENT') return;
      throw err;
    }
    delete memory.lastMenu; delete memory.lastPicks; delete memory.activeBeer;
    memory.currentConstraints=[];memory.updatedAt=new Date().toISOString();
    await writeFile(filePath,JSON.stringify(memory,null,2)+'\n','utf8');
  });
}
