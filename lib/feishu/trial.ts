import { extractFeishuMessage, type FeishuEventPayload } from "./client.ts";

const appKeys = ["FEISHU_APP_ID", "FEISHU_APP_SECRET"] as const;
const legacyProviderKey = "OPENROUTER_API_KEY";
const packageProviderKey = "CODING_PLAN_API_KEY";
const packageProviderSelector = "coding-plan";
const placeholderPattern = /^(?:<.*>|xxx|cli_xxx|replace.*|your[-_ ].*)$/i;

function isMissingField(value: string | undefined) {
  const trimmed = value?.trim();
  return !trimmed || placeholderPattern.test(trimmed);
}

/** 只返回缺失字段名，绝不回显配置值。 */
export function checkFeishuTrialConfig(env: Record<string, string | undefined>) {
  const missing: string[] = appKeys.filter(key => isMissingField(env[key]));
  const selector = env.BEER_VISION_PROVIDER?.trim() ?? "";
  if (selector === "") {
    if (isMissingField(env[legacyProviderKey])) missing.push(legacyProviderKey);
  } else if (selector === packageProviderSelector) {
    if (isMissingField(env[packageProviderKey])) missing.push(packageProviderKey);
  } else {
    // 非空但未识别的选择器必须失败关闭：只给稳定字段名，绝不回显原值。
    missing.push("BEER_VISION_PROVIDER");
  }
  return { ready: missing.length === 0, missing, mode: "private-chat" as const };
}

export type FeishuSocketEvent = {
  event_id?: string;
  sender?: { sender_type?: string; sender_id?: { open_id?: string } };
  message?: NonNullable<NonNullable<FeishuEventPayload["event"]>["message"]> & { chat_type?: string };
};

/** 试用入口只接收用户私聊，群消息与机器人消息不进入业务处理。 */
export function getTrialMessage(event: FeishuSocketEvent, allowedOpenIds: readonly string[] = []) {
  if (event.sender?.sender_type !== "user" || event.message?.chat_type !== "p2p") return null;
  if (allowedOpenIds.length && !allowedOpenIds.includes(event.sender.sender_id?.open_id ?? "")) return null;
  const incoming = extractFeishuMessage({ event: { message: event.message } });
  return incoming?.messageId && incoming.chatId ? incoming : null;
}
