import { NextResponse } from "next/server";
import { runBeerAgent } from "@/lib/beer-agent/provider";
import {
  downloadFeishuImage,
  extractFeishuMessage,
  getFeishuChallenge,
  hasEncryptedFeishuPayload,
  isFeishuVerificationTokenValid,
  replyFeishuMessage,
  shouldSkipFeishuEvent
} from "@/lib/feishu/client";
import {
  appendConversationTurn,
  clearConversation,
  getConversationMessages
} from "@/lib/feishu/conversations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = await request.json();

  if (!isFeishuVerificationTokenValid(payload)) {
    return NextResponse.json({ ok: false, error: "invalid_verification_token" }, { status: 401 });
  }

  const challenge = getFeishuChallenge(payload);

  if (challenge) {
    return NextResponse.json({ challenge });
  }

  if (hasEncryptedFeishuPayload(payload)) {
    return NextResponse.json(
      {
        ok: false,
        error: "encrypted_payload_not_supported_yet",
        hint: "Temporarily disable event encryption in Feishu, or add decryption support next."
      },
      { status: 501 }
    );
  }

  if (shouldSkipFeishuEvent(payload)) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const incomingMessage = extractFeishuMessage(payload);
  if (!incomingMessage?.messageId) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  if (incomingMessage.messageType !== "text" && incomingMessage.messageType !== "image") {
    await replyFeishuMessage(
      incomingMessage.messageId,
      "我现在先支持文本和图片。你可以直接发酒单照片，或者发一句“今天想喝清爽一点，不要太苦”。"
    );
    return NextResponse.json({ ok: true, ignored: true, reason: "unsupported_message_type" });
  }

  const image =
    incomingMessage.messageType === "image" && incomingMessage.imageKey
      ? await downloadFeishuImage(incomingMessage.imageKey)
      : undefined;

  const userPrompt =
    incomingMessage.messageType === "text"
      ? incomingMessage.text
      : "这张酒单/酒标图片帮我看下，按我的口味推荐，并说明有无明显风险。";

  if (incomingMessage.messageType === "text" && isResetCommand(userPrompt)) {
    await clearConversation(incomingMessage.chatId);
    await replyFeishuMessage(
      incomingMessage.messageId,
      "这段对话的上下文我已经清空了。你现在可以重新发酒单、酒标或一句需求。"
    );
    return NextResponse.json({ ok: true, reset: true });
  }

  const history = incomingMessage.chatId
    ? await getConversationMessages(incomingMessage.chatId)
    : [];
  const userMessage = { role: "user" as const, content: userPrompt };

  const result = await runBeerAgent({
    messages: [...history, userMessage],
    image: image
      ? {
          name: `${incomingMessage.imageKey || "feishu-image"}.jpg`,
          type: image.type,
          dataUrl: image.dataUrl
        }
      : undefined
  });

  if (incomingMessage.chatId) {
    await appendConversationTurn(incomingMessage.chatId, userMessage, {
      role: "assistant",
      content: result.reply
    });
  }

  await replyFeishuMessage(incomingMessage.messageId, result.reply);

  return NextResponse.json({ ok: true });
}

function isResetCommand(text: string) {
  const normalized = text.trim().toLowerCase();
  return ["清空", "重置", "reset", "/reset", "清空记忆", "重开"].includes(normalized);
}
