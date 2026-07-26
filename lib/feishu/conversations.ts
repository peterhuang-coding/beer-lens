import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "@/lib/beer-agent/types";

type ConversationTurnStatus = "processing" | "done" | "failed";

type ConversationTurnRecord = {
  sequence: number;
  messageId: string;
  status: ConversationTurnStatus;
  userMessage: ChatMessage;
  assistantMessage?: ChatMessage;
  updatedAt: string;
};

type ConversationRecord = {
  chatId: string;
  messages: ChatMessage[];
  baseMessages?: ChatMessage[];
  turns?: ConversationTurnRecord[];
  nextSequence?: number;
  updatedAt: string;
};

type ConversationFile = {
  version: number;
  conversations: Record<string, ConversationRecord>;
};

const conversationsPath = path.join(process.cwd(), "data", "feishu_conversations.json");
const conversationsLockPath = `${conversationsPath}.lock`;
const maxMessagesPerConversation = 24;
const lockTimeoutMs = 5_000;

export async function getConversationMessages(chatId: string) {
  const file = await readConversationFile();
  return file.conversations[chatId]?.messages ?? [];
}

export async function appendConversationTurn(
  chatId: string,
  userMessage: ChatMessage,
  assistantMessage: ChatMessage
) {
  await withConversationFileLock(async () => {
    const file = await readConversationFile();
    const record = getOrCreateConversation(file, chatId);
    const sequence = reserveSequence(record);

    ensureManagedTurns(record).push({
      sequence,
      messageId: `legacy:${sequence}`,
      status: "done",
      userMessage,
      assistantMessage,
      updatedAt: new Date().toISOString()
    });
    rebuildMessages(record);
    record.updatedAt = new Date().toISOString();

    await writeConversationFile(file);
  });
}

export async function beginConversationTurn(
  chatId: string,
  messageId: string,
  userMessage: ChatMessage
): Promise<boolean> {
  return withConversationFileLock(async () => {
    const file = await readConversationFile();
    const record = getOrCreateConversation(file, chatId);
    const turns = ensureManagedTurns(record);

    if (turns.some((turn) => turn.messageId === messageId)) {
      return false;
    }

    turns.push({
      sequence: reserveSequence(record),
      messageId,
      status: "processing",
      userMessage,
      updatedAt: new Date().toISOString()
    });
    record.updatedAt = new Date().toISOString();
    await writeConversationFile(file);
    return true;
  });
}

export async function completeConversationTurn(
  chatId: string,
  messageId: string,
  assistantMessage: ChatMessage,
  status: Exclude<ConversationTurnStatus, "processing">
) {
  await withConversationFileLock(async () => {
    const file = await readConversationFile();
    const record = file.conversations[chatId];
    const turn = record?.turns?.find((candidate) => candidate.messageId === messageId);

    if (!record || !turn) {
      throw new Error(`Missing Feishu conversation placeholder for ${messageId}`);
    }
    if (turn.status !== "processing") {
      return;
    }

    turn.status = status;
    turn.assistantMessage = assistantMessage;
    turn.updatedAt = new Date().toISOString();
    rebuildMessages(record);
    record.updatedAt = new Date().toISOString();
    await writeConversationFile(file);
  });
}

export async function clearConversation(chatId: string) {
  await withConversationFileLock(async () => {
    const file = await readConversationFile();
    if (!file.conversations[chatId]) return;
    delete file.conversations[chatId];
    await writeConversationFile(file);
  });
}

function getOrCreateConversation(file: ConversationFile, chatId: string): ConversationRecord {
  const existing = file.conversations[chatId];
  if (existing) return existing;

  const record: ConversationRecord = {
    chatId,
    messages: [],
    updatedAt: new Date().toISOString()
  };
  file.conversations[chatId] = record;
  return record;
}

function ensureManagedTurns(record: ConversationRecord): ConversationTurnRecord[] {
  if (!record.turns) {
    record.baseMessages = [...record.messages];
    record.turns = [];
  }
  return record.turns;
}

function reserveSequence(record: ConversationRecord): number {
  const next = record.nextSequence ?? (
    Math.max(0, ...(record.turns ?? []).map((turn) => turn.sequence)) + 1
  );
  record.nextSequence = next + 1;
  return next;
}

function rebuildMessages(record: ConversationRecord) {
  const completedMessages = (record.turns ?? [])
    .filter((turn) => turn.status !== "processing" && turn.assistantMessage)
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap((turn) => [turn.userMessage, turn.assistantMessage!]);

  record.messages = [...(record.baseMessages ?? []), ...completedMessages]
    .slice(-maxMessagesPerConversation);
}

async function withConversationFileLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(conversationsPath), { recursive: true });
  await acquireConversationFileLock();
  try {
    return await fn();
  } finally {
    await rm(conversationsLockPath, { recursive: true, force: true });
  }
}

async function acquireConversationFileLock() {
  const deadline = Date.now() + lockTimeoutMs;

  while (true) {
    try {
      await mkdir(conversationsLockPath);
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }

    if (Date.now() >= deadline) {
      throw new Error("Timed out acquiring Feishu conversation lock");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function readConversationFile(): Promise<ConversationFile> {
  try {
    const raw = await readFile(conversationsPath, "utf8");
    return JSON.parse(raw) as ConversationFile;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    return {
      version: 1,
      conversations: {}
    };
  }
}

async function writeConversationFile(file: ConversationFile) {
  const temporaryPath = `${conversationsPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(temporaryPath, conversationsPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
