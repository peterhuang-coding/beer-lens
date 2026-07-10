import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "@/lib/beer-agent/types";

type ConversationRecord = {
  chatId: string;
  messages: ChatMessage[];
  updatedAt: string;
};

type ConversationFile = {
  version: number;
  conversations: Record<string, ConversationRecord>;
};

const conversationsPath = path.join(process.cwd(), "data", "feishu_conversations.json");
const maxMessagesPerConversation = 24;

export async function getConversationMessages(chatId: string) {
  const file = await readConversationFile();
  return file.conversations[chatId]?.messages ?? [];
}

export async function appendConversationTurn(
  chatId: string,
  userMessage: ChatMessage,
  assistantMessage: ChatMessage
) {
  const file = await readConversationFile();
  const existing = file.conversations[chatId]?.messages ?? [];
  const messages = [...existing, userMessage, assistantMessage].slice(-maxMessagesPerConversation);

  file.conversations[chatId] = {
    chatId,
    messages,
    updatedAt: new Date().toISOString()
  };

  await writeConversationFile(file);
}

export async function clearConversation(chatId: string) {
  const file = await readConversationFile();
  if (!file.conversations[chatId]) return;
  delete file.conversations[chatId];
  await writeConversationFile(file);
}

async function readConversationFile(): Promise<ConversationFile> {
  try {
    const raw = await readFile(conversationsPath, "utf8");
    return JSON.parse(raw) as ConversationFile;
  } catch {
    return {
      version: 1,
      conversations: {}
    };
  }
}

async function writeConversationFile(file: ConversationFile) {
  await writeFile(conversationsPath, `${JSON.stringify(file, null, 2)}\n`);
}

