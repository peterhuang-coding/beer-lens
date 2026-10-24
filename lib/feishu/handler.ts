import { runAgentTurn } from "../agent/controller.ts";
import { handleMbcbQuery } from "./mbcb.ts";
import { downloadFeishuImage, replyFeishuMessage, type FeishuIncomingMessage } from "./client.ts";
import { beginConversationTurn, clearConversation, completeConversationTurn, getConversationMessages } from "./conversations.ts";
import { FeishuMessageQueue } from "./queue.ts";
import { clearShortTermMemory } from "../beer-agent/memory/short-term.ts";
import { createTurnTiming, type TurnTiming } from "./turn-timing.ts";

const queue = new FeishuMessageQueue();

export function enqueueFeishuMessage(message: FeishuIncomingMessage): Promise<void> {
  // T_recv：入队前即刻记录单调时间；每个入站消息一个独立计时对象。
  const timing = createTurnTiming(message.messageType);
  return queue.enqueue(message.chatId, () => runQueuedMessage(message, timing));
}

export function drainFeishuMessages(): Promise<void> {
  return queue.drain();
}

async function runQueuedMessage(message: FeishuIncomingMessage, timing: TurnTiming): Promise<void> {
  // T_start：回调真正出队执行时；队列等待由此与处理耗时分开计量。
  timing.markStarted();
  try {
    await processMessage(message, timing);
  } finally {
    // T_end 之后每条入队消息恰好落一条记录；sink 失败不影响消息结果。
    timing.finish();
  }
}

async function processMessage(message: FeishuIncomingMessage, timing: TurnTiming): Promise<void> {
  try {
    await processMessageTurn(message, timing);
  } catch {
    // 此刻标记错误类别：若转义的失败来自回发调用则记 reply_error，
    // 否则记 processing_error；随后兜底文案即使发成功也不改写结果。
    timing.markTurnFailed(timing.replyFailureSeen() ? "reply_error" : "processing_error");
    // 不把提供方响应、凭据或内部错误详情发到聊天里。
    console.error("[feishu] 消息处理失败，请检查项目服务日志与配置。");
    try {
      await sendReply(message, "暂时无法处理这条消息，请稍后重试。", timing);
    } catch {
      console.error("[feishu] 错误提示发送失败，请检查机器人权限。");
    }
  }
}

async function sendReply(
  message: FeishuIncomingMessage,
  text: string,
  timing: TurnTiming
): Promise<void> {
  timing.markReplyAttempt();
  try {
    await replyFeishuMessage(message.messageId, text);
    timing.markReplySuccess();
  } catch (error) {
    timing.markReplyFailure();
    throw error;
  }
}

async function processMessageTurn(message: FeishuIncomingMessage, timing: TurnTiming): Promise<void> {
  if (!["text", "image", "post"].includes(message.messageType)) {
    await sendReply(message, "我现在支持文字和图片。你可以直接发酒单照片。", timing);
    return;
  }

  const userText = message.text;
  if (["清空", "重置", "reset", "/reset", "清空记忆", "重开"].includes(userText.trim())) {
    await clearConversation(message.chatId);
    await clearShortTermMemory(message.chatId, message.chatId);
    await sendReply(message, "当前对话和菜单已重置，长期口味记录保留。", timing);
    return;
  }

  // Explicit MBCB catalog commands only (text); images and ordinary chat
  // fall through to the normal agent path untouched.
  if (message.messageType === "text") {
    const catalogReply = await handleMbcbQuery(userText);
    if (catalogReply !== null) {
      await sendReply(message, catalogReply, timing);
      return;
    }
  }

  const caseLabel = parseCaseLabel(userText);
  if (caseLabel) {
    const { listCases, updateCase } = await import("../beer-agent/cases.ts");
    const lastCase = (await listCases({})).find(c => c.conversationId === message.chatId);
    if (lastCase) {
      await updateCase(lastCase.id, { label: caseLabel.label, note: caseLabel.note || lastCase.note });
      await sendReply(message, `已标记: ${caseLabel.label}${caseLabel.note ? " — " + caseLabel.note : ""}`, timing);
    } else {
      await sendReply(message, "没找到上一轮对话记录。", timing);
    }
    return;
  }

  const userMessage = { role: "user" as const, content: userText || (message.imageKey ? "帮我看看这张图" : "") };
  const history = await getConversationMessages(message.chatId);
  if (!await beginConversationTurn(message.chatId, message.messageId, userMessage)) {
    timing.markDuplicate();
    return;
  }

  let reply: string;
  let status: "done" | "failed" = "done";
  try {
    const image = message.imageKey
      ? await timing.measure("imageDownloadMs", () => downloadFeishuImage(message.imageKey, message.messageId))
      : undefined;
    const result = await timing.measure("agentMs", () => runAgentTurn({
      userId: message.chatId,
      channel: "feishu",
      conversationId: message.chatId,
      turnId: message.messageId,
      messages: [...history, userMessage],
      image: image ? { name: "feishu-image", type: image.type, dataUrl: image.dataUrl } : undefined,
    }));
    reply = result.reply;
    if (result.debug?.warnings?.length) {
      // 技术告警：会话状态记 failed，计时同样不得算作 SLO 成功。
      status = "failed";
      timing.markTurnFailed("processing_error");
    }
  } catch {
    // 图片下载或 agent 内部失败：即使兜底文案回发成功，也必须先标记
    // processing_error，不能让一次成功的错误回复把本轮计入 SLO ok。
    status = "failed";
    timing.markTurnFailed("processing_error");
    reply = "处理出错了，请稍后重试。";
    console.error("[feishu] 对话处理失败。");
  }

  await timing.measure("memoryWriteMs", () =>
    completeConversationTurn(message.chatId, message.messageId, { role: "assistant", content: reply }, status)
  );
  await sendReply(message, reply, timing);
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
