type TenantTokenResponse = {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
};

type FeishuUserId = {
  open_id?: string;
  union_id?: string;
  user_id?: string;
};

type FeishuMessage = {
  message_id?: string;
  chat_id?: string;
  message_type?: string;
  content?: string;
};

type FeishuEventPayload = {
  challenge?: string;
  token?: string;
  type?: string;
  event_id?: string;
  encrypt?: string;
  header?: {
    event_type?: string;
    event_id?: string;
    token?: string;
  };
  event?: {
    sender?: {
      sender_id?: FeishuUserId;
    };
    message?: FeishuMessage;
  };
};

let cachedTenantToken: {
  token: string;
  expiresAt: number;
} | null = null;

const processedEventIds = new Map<string, number>();

export function getFeishuChallenge(payload: FeishuEventPayload) {
  return payload.challenge;
}

export function isFeishuVerificationTokenValid(payload: FeishuEventPayload) {
  const configuredToken = process.env.FEISHU_VERIFICATION_TOKEN;
  if (!configuredToken) {
    return true;
  }

  // Feishu v1: token is at payload.token
  // Feishu v2: token is at payload.header.token
  const requestToken = payload.token ?? payload.header?.token;
  return requestToken === configuredToken;
}

export function hasEncryptedFeishuPayload(payload: FeishuEventPayload) {
  return Boolean(payload.encrypt);
}

export function extractFeishuMessage(payload: FeishuEventPayload) {
  const message = payload.event?.message;
  if (!message || !message.message_type || !message.content) {
    return null;
  }

  try {
    const parsed = JSON.parse(message.content);

    // Post type: {"title":"","content":[[{"tag":"img","image_key":"..."}],[{"tag":"text","text":"..."}]]}
    if (message.message_type === "post") {
      const blocks = (parsed.content as any[][]) ?? [];
      let text = "";
      let imageKey = "";
      for (const row of blocks) {
        for (const block of (row as any[])) {
          if (block.tag === "text" && block.text) text += block.text;
          if (block.tag === "img" && block.image_key) imageKey = block.image_key;
        }
      }
      return {
        text: text.trim(),
        imageKey,
        fileKey: "",
        messageId: message.message_id ?? "",
        chatId: message.chat_id ?? "",
        messageType: message.message_type,
      };
    }

    // Text type: {"text":"hello"}
    // Image type: {"image_key":"img_xxx"}
    return {
      text: (parsed as any).text?.trim() ?? "",
      imageKey: (parsed as any).image_key ?? "",
      fileKey: (parsed as any).file_key ?? "",
      messageId: message.message_id ?? "",
      chatId: message.chat_id ?? "",
      messageType: message.message_type,
    };
  } catch {
    return null;
  }
}

export async function replyFeishuMessage(messageId: string, text: string) {
  if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
    throw new Error("Missing FEISHU_APP_ID or FEISHU_APP_SECRET");
  }

  const token = await getTenantAccessToken();
  const response = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        msg_type: "text",
        content: JSON.stringify({ text })
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Feishu reply failed ${response.status}: ${await response.text()}`);
  }
}

export async function downloadFeishuImage(imageKey: string, messageId?: string) {
  const token = await getTenantAccessToken();
  // Use the "获取消息中的资源文件" endpoint for user-sent images
  const url = messageId
    ? `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`
    : `https://open.feishu.cn/open-apis/im/v1/images/${imageKey}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error(`Feishu image download failed ${response.status}: ${await response.text()}`);
  }

  const mimeType = response.headers.get("content-type") ?? "image/jpeg";
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");

  return {
    type: mimeType,
    dataUrl: `data:${mimeType};base64,${base64}`
  };
}

export function shouldSkipFeishuEvent(payload: FeishuEventPayload) {
  const eventId = payload.header?.event_id ?? payload.event_id;
  if (!eventId) return false;

  const now = Date.now();
  for (const [id, expiresAt] of processedEventIds.entries()) {
    if (expiresAt <= now) processedEventIds.delete(id);
  }

  if (processedEventIds.has(eventId)) {
    return true;
  }

  processedEventIds.set(eventId, now + 10 * 60 * 1000);
  return false;
}

async function getTenantAccessToken() {
  if (cachedTenantToken && cachedTenantToken.expiresAt > Date.now() + 60_000) {
    return cachedTenantToken.token;
  }

  const response = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        app_id: process.env.FEISHU_APP_ID,
        app_secret: process.env.FEISHU_APP_SECRET
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Feishu token failed ${response.status}: ${await response.text()}`);
  }

  const result = (await response.json()) as TenantTokenResponse;
  if (result.code !== 0 || !result.tenant_access_token) {
    throw new Error(`Feishu token failed: ${result.msg}`);
  }

  cachedTenantToken = {
    token: result.tenant_access_token,
    expiresAt: Date.now() + (result.expire ?? 7200) * 1000
  };

  return cachedTenantToken.token;
}
