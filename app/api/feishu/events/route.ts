import { NextResponse } from 'next/server';
import { runAgentTurn } from '@/lib/agent/controller';
import {
  downloadFeishuImage,
  extractFeishuMessage,
  getFeishuChallenge,
  hasEncryptedFeishuPayload,
  isFeishuVerificationTokenValid,
  replyFeishuMessage,
  shouldSkipFeishuEvent
} from '@/lib/feishu/client';
import {
  appendConversationTurn,
  clearConversation,
  getConversationMessages
} from '@/lib/feishu/conversations';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const payload = await request.json();

  if (!isFeishuVerificationTokenValid(payload)) {
    return NextResponse.json({ ok: false, error: 'invalid_verification_token' }, { status: 401 });
  }

  const challenge = getFeishuChallenge(payload);

  if (challenge) {
    return NextResponse.json({ challenge });
  }

  if (hasEncryptedFeishuPayload(payload)) {
    return NextResponse.json(
      { ok: false, error: 'encrypted_payload_not_supported_yet' },
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

  const supported = ['text', 'image', 'post'];
  if (!supported.includes(incomingMessage.messageType)) {
    await replyFeishuMessage(
      incomingMessage.messageId,
      '我现在先支持文本和图片。你可以直接发酒单照片。'
    );
    return NextResponse.json({ ok: true, ignored: true });
  }

  const userText = incomingMessage.text ?? '';
  const image = incomingMessage.imageKey
    ? await downloadFeishuImage(incomingMessage.imageKey, incomingMessage.messageId)
    : undefined;
  const userPrompt = userText || (image ? '帮我看看这张图' : '');

  if (isResetCommand(userText)) {
    await clearConversation(incomingMessage.chatId);
    await replyFeishuMessage(incomingMessage.messageId, '上下文已清空。');
    return NextResponse.json({ ok: true, reset: true });
  }

  // Check if this is a case labeling command
  const caseLabel = parseCaseLabel(userText);
  if (caseLabel) {
    const { updateCase } = await import('@/lib/beer-agent/cases');
    const { listCases } = await import('@/lib/beer-agent/cases');
    const allCases = await listCases({});
    const lastCase = allCases.find(c => c.conversationId === incomingMessage.chatId);
    if (lastCase) {
      await updateCase(lastCase.id, { label: caseLabel.label as import('@/lib/beer-agent/cases').CaseLabel, note: caseLabel.note || lastCase.note });
      await replyFeishuMessage(incomingMessage.messageId,
        `已标记: ${caseLabel.label}${caseLabel.note ? ' — ' + caseLabel.note : ''}`);
    } else {
      await replyFeishuMessage(incomingMessage.messageId, '没找到上一轮对话记录。');
    }
    return NextResponse.json({ ok: true, labeled: true });
  }

  const history = incomingMessage.chatId
    ? await getConversationMessages(incomingMessage.chatId)
    : [];
  const userMessage = { role: 'user' as const, content: userPrompt };

  const imagePayload = image
    ? { name: (incomingMessage.imageKey || 'img') + '.jpg', type: image.type, dataUrl: image.dataUrl }
    : undefined;

  runAgentTurn({
    userId: incomingMessage.chatId,
    channel: 'feishu',
    conversationId: incomingMessage.chatId,
    turnId: incomingMessage.messageId,
    messages: [...history, userMessage],
    image: imagePayload,
  }).then(async (result) => {
    if (incomingMessage.chatId) {
      await appendConversationTurn(incomingMessage.chatId, userMessage, {
        role: 'assistant',
        content: result.reply
      });
    }
    await replyFeishuMessage(incomingMessage.messageId, result.reply);
  }).catch(async (err) => {
    console.error('[feishu] agent error:', err);
    const errMsg = err instanceof Error ? err.message : String(err);
    await replyFeishuMessage(incomingMessage.messageId, `处理出错了，请稍后再试。（${errMsg.slice(0, 50)}）`);
  });

  return NextResponse.json({ ok: true });
}

function isResetCommand(text: string) {
  return ['清空', '重置', 'reset', '/reset', '清空记忆', '重开'].includes(text.trim());
}

const CASE_LABELS = [
  'good', 'intent_wrong', 'ocr_wrong', 'recommendation_bad',
  'hallucination', 'memory_wrong', 'data_missing', 'response_bad',
];

function parseCaseLabel(text: string): { label: string; note?: string } | null {
  const t = text.trim();
  for (const p of [
    new RegExp(`^(?:bad|标签|标记|label)[：:]\\s*(${CASE_LABELS.join('|')})(?:\\s+(.*))?$`, 'i'),
    new RegExp(`^(${CASE_LABELS.join('|')})(?:\\s+(.*))?$`, 'i'),
  ]) {
    const m = t.match(p);
    if (m) return { label: m[1], note: m[2] || undefined };
  }
  return null;
}
