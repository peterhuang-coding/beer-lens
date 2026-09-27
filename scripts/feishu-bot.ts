import { checkFeishuTrialConfig, getTrialMessage } from "../lib/feishu/trial.ts";
import { shouldSkipFeishuEvent } from "../lib/feishu/client.ts";

const check = checkFeishuTrialConfig(process.env);
if (process.argv.includes("--check")) {
  console.log(JSON.stringify({ ...check, connectionVerified: false }, null, 2));
  process.exitCode = check.ready ? 0 : 1;
} else if (!check.ready) {
  console.error(`飞书试用未启动，缺少项目配置：${check.missing.join("、")}`);
  process.exitCode = 1;
} else {
  const { WSClient, EventDispatcher, LoggerLevel } = await import("@larksuiteoapi/node-sdk");
  const { enqueueFeishuMessage, drainFeishuMessages } = await import("../lib/feishu/handler.ts");
  const allowedIds = (process.env.FEISHU_ALLOWED_OPEN_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  let stopping = false;

  // SDK 错误参数可能包含请求配置，不将其写入日志。
  const logger = {
    error: () => console.error("[feishu] 连接发生错误，请检查项目机器人配置和事件订阅。"),
    warn: () => console.warn("[feishu] 连接暂不可用，正在重连。"),
    info: () => {}, debug: () => {}, trace: () => {},
  };
  const client = new WSClient({
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
    logger, loggerLevel: LoggerLevel.warn,
    handshakeTimeoutMs: 20_000,
    onReady: () => console.log("Beer Lens 飞书长连接已建立，可以私聊机器人。模型回答需另行实测。"),
    onReconnected: () => console.log("Beer Lens 飞书长连接已恢复。"),
    onError: () => { client.close({ force: true }); console.error("飞书连接失败，尚不可试用。"); process.exitCode = 1; },
  });
  const dispatcher = new EventDispatcher({ logger, loggerLevel: LoggerLevel.warn }).register({
    "im.message.receive_v1": data => {
      if (stopping) throw new Error("service_stopping");
      const message = getTrialMessage(data, allowedIds);
      if (message && !shouldSkipFeishuEvent({ event_id: data.event_id ?? message.messageId })) {
        // 立即确认事件；模型调用在队列中执行，避免超过飞书的三秒回执窗口。
        void enqueueFeishuMessage(message).catch(() => console.error("[feishu] 消息队列处理失败。"));
      }
      return {};
    },
  });

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    client.close({ force: true });
    console.log("停止接收新消息，等待已接收的消息处理完成。");
    const deadline = setTimeout(() => process.exit(1), 150_000);
    deadline.unref();
    await drainFeishuMessages();
    clearTimeout(deadline);
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  try {
    await client.start({ eventDispatcher: dispatcher });
  } catch {
    client.close({ force: true });
    console.error("飞书连接失败，尚不可试用。");
    process.exitCode = 1;
  }
}
