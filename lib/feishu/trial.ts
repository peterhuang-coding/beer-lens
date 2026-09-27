import { extractFeishuMessage, type FeishuEventPayload } from "./client.ts";

const requiredKeys = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "OPENROUTER_API_KEY"] as const;

/** 只返回缺失字段名，绝不回显配置值。 */
export function checkFeishuTrialConfig(env: Record<string, string | undefined>) {
  const missing = requiredKeys.filter(key => {
    const value = env[key]?.trim();
    return !value || /^(?:<.*>|xxx|cli_xxx|replace.*|your[-_ ].*)$/i.test(value);
  });
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
