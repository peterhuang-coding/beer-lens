import { after, NextResponse } from "next/server";
import {
  extractFeishuMessage,
  getFeishuChallenge,
  hasEncryptedFeishuPayload,
  isFeishuVerificationTokenValid,
  shouldSkipFeishuEvent,
} from "@/lib/feishu/client";
import { enqueueFeishuMessage } from "@/lib/feishu/handler";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }
  if (!isFeishuVerificationTokenValid(payload)) {
    return NextResponse.json({ ok: false, error: "invalid_verification_token" }, { status: 401 });
  }
  const challenge = getFeishuChallenge(payload);
  if (challenge) return NextResponse.json({ challenge });
  if (hasEncryptedFeishuPayload(payload)) {
    return NextResponse.json({ ok: false, error: "encrypted_payload_not_supported_yet" }, { status: 501 });
  }
  const message = extractFeishuMessage(payload);
  if (!message?.messageId || !message.chatId) {
    return NextResponse.json({ ok: true, ignored: true });
  }
  if (shouldSkipFeishuEvent(payload)) return NextResponse.json({ ok: true, skipped: true });

  // 先回执；下载图片、模型处理和回复都在后台串行队列中完成。
  after(() => enqueueFeishuMessage(message));
  return NextResponse.json({ ok: true, status: "processing", messageId: message.messageId });
}
