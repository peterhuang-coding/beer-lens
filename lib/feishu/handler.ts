import { runAgentTurn } from "../agent/controller.ts";
import { downloadFeishuImage, replyFeishuMessage, type FeishuIncomingMessage } from "./client.ts";
import { beginConversationTurn, clearConversation, completeConversationTurn, getConversationMessages } from "./conversations.ts";
import { FeishuMessageQueue } from "./queue.ts";
import { clearShortTermMemory } from "../beer-agent/memory/short-term.ts";

const queue = new FeishuMessageQueue();

export function enqueueFeishuMessage(message: FeishuIncomingMessage): Promise<void> {
  return queue.enqueue(message.chatId, () => processMessage(message));
}

export function drainFeishuMessages(): Promise<void> {
  return queue.drain();
}

async function processMessage(message: FeishuIncomingMessage): Promise<void> {
  try {
    await processMessageTurn(message);
  } catch {
    // 不把提供方响应、凭据或内部错误详情发到聊天里。
    console.error("[feishu] 消息处理失败，请检查项目服务日志与配置。");
    try {
      await replyFeishuMessage(message.messageId, "暂时无法处理这条消息，请稍后重试。");
    } catch {
      console.error("[feishu] 错误提示发送失败，请检查机器人权限。");
    }
  }
}

async function processMessageTurn(message: FeishuIncomingMessage): Promise<void> {
  if (!["text", "image", "post"].includes(message.messageType)) {
    await replyFeishuMessage(message.messageId, "我现在支持文字和图片。你可以直接发酒单照片。");
    return;
  }

  const userText = message.text;
  if (["清空", "重置", "reset", "/reset", "清空记忆", "重开"].includes(userText.trim())) {
    await clearConversation(message.chatId);
    await clearShortTermMemory(message.chatId, message.chatId);
    await replyFeishuMessage(message.messageId, "当前对话和菜单已重置，长期口味记录保留。");
    return;
  }

  const caseLabel = parseCaseLabel(userText);
  if (caseLabel) {
    const { listCases, updateCase } = await import("../beer-agent/cases.ts");
    const lastCase = (await listCases({})).find(c => c.conversationId === message.chatId);
    if (lastCase) {
      await updateCase(lastCase.id, { label: caseLabel.label, note: caseLabel.note || lastCase.note });
      await replyFeishuMessage(message.messageId, `已标记: ${caseLabel.label}${caseLabel.note ? " — " + caseLabel.note : ""}`);
    } else {
      await replyFeishuMessage(message.messageId, "没找到上一轮对话记录。");
    }
    return;
  }

  const userMessage = { role: "user" as const, content: userText || (message.imageKey ? "帮我看看这张图" : "") };
  const history = await getConversationMessages(message.chatId);
  if (!await beginConversationTurn(message.chatId, message.messageId, userMessage)) return;

  let reply: string;
  let status: "done" | "failed" = "done";
  try {
    const image = message.imageKey
      ? await downloadFeishuImage(message.imageKey, message.messageId)
      : undefined;
    const result = await runAgentTurn({
      userId: message.chatId,
      channel: "feishu",
      conversationId: message.chatId,
      turnId: message.messageId,
      messages: [...history, userMessage],
      image: image ? { name: "feishu-image", type: image.type, dataUrl: image.dataUrl } : undefined,
    });
    reply = result.reply;
    if (result.debug?.warnings?.length) status = "failed";
  } catch {
    status = "failed";
    reply = "处理出错了，请稍后重试。";
    console.error("[feishu] 对话处理失败。");
  }

  await completeConversationTurn(message.chatId, message.messageId, { role: "assistant", content: reply }, status);
  await replyFeishuMessage(message.messageId, reply);
}

const CASE_LABELS = ["good", "intent_wrong", "ocr_wrong", "recommendation_bad", "hallucination", "memory_wrong", "data_missing", "response_bad"] as const;

function parseCaseLabel(text: string): { label: typeof CASE_LABELS[number]; note?: string } | null {
  for (const pattern of [
    new RegExp(`^(?:bad|标签|标记|label)[：:]\\s*(${CASE_LABELS.join("|")})(?:\\s+(.*))?$`, "i"),
    new RegExp(`^(${CASE_LABELS.join("|")})(?:\\s+(.*))?$`, "i"),
  ]) {
    const match = text.trim().match(pattern);
    if (match) return { label: match[1].toLowerCase() as typeof CASE_LABELS[number], note: match[2] || undefined };
  }
  return null;
}
