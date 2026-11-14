import { extractFeishuMessage, type FeishuEventPayload } from "./client.ts";
import { resolveAgentTextRoute } from "../beer-agent/text-routing.ts";

const appKeys = ["FEISHU_APP_ID", "FEISHU_APP_SECRET"] as const;
const legacyProviderKey = "OPENROUTER_API_KEY";
const packageProviderKey = "CODING_PLAN_API_KEY";
const anthropicProviderKey = "ANTHROPIC_API_KEY";
const deepseekProviderKey = "DEEPSEEK_API_KEY";
const packageProviderSelector = "coding-plan";
const anthropicProviderSelector = "anthropic";
const deepseekProviderSelector = "deepseek";
const llmFields = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const;
const placeholderPattern = /^(?:<.*>|xxx|cli_xxx|replace.*|your[-_ ].*)$/i;

function isMissingField(value: string | undefined) {
  const trimmed = value?.trim();
  return !trimmed || placeholderPattern.test(trimmed);
}

/** 只返回缺失字段名，绝不回显配置值。 */
export function checkFeishuTrialConfig(env: Record<string, string | undefined>) {
  const missing: string[] = appKeys.filter(key => isMissingField(env[key]));
  const seen = new Set(missing);
  const requireField = (field: string) => {
    if (!seen.has(field)) {
      missing.push(field);
      seen.add(field);
    }
  };
  const requireKey = (field: string) => {
    if (isMissingField(env[field])) requireField(field);
  };

  const imageSelector = env.BEER_VISION_PROVIDER?.trim() ?? "";
  if (imageSelector === "") {
    requireKey(legacyProviderKey);
  } else if (imageSelector === packageProviderSelector) {
    requireKey(packageProviderKey);
  } else if (imageSelector === anthropicProviderSelector) {
    requireKey(anthropicProviderKey);
  } else if (imageSelector === deepseekProviderSelector) {
    requireKey(deepseekProviderKey);
  } else {
    // 非空但未识别的选择器必须失败关闭：只给稳定字段名，绝不回显原值。
    requireField("BEER_VISION_PROVIDER");
  }

  const textRoute = resolveAgentTextRoute(env);
  if (textRoute.error !== null) {
    requireField(textRoute.field ?? "BEER_TEXT_PROVIDER");
  } else if (textRoute.route?.mode === "package") {
    requireKey(packageProviderKey);
  } else if (textRoute.route?.mode === "llm") {
    for (const field of llmFields) requireKey(field);
  } else {
    requireKey(legacyProviderKey);
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
