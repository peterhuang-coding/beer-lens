/**
 * User-facing degrade messages.
 *
 * Maps a VisionError (or any thrown object) to a short Chinese copy
 * that the recommend skill can show instead of the raw exception text.
 *
 * Keep these short (one sentence) and actionable. The goal is for the
 * user to either retry, change input, or fall back to typing the beer
 * name manually.
 */

import type { VisionError } from "./errors.ts";

export function suggest(err: VisionError | Error | unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "TIMEOUT":
      return "这次识别慢了,可能是图片太大或网络不稳。再发一次试试?";
    case "NETWORK":
      return "视觉服务连不上。先检查网络,再发一次图片?";
    case "PARSE":
      return "我从图里识别到一半没解析明白。试试拍清楚一点再发一次?";
    case "RATE_LIMIT":
      return "视觉服务这会儿限流。等几秒再试一次?";
    case "AUTH":
      return "视觉服务的 API key 配错了,先告诉开发者吧。";
    case "SIZE":
      return "这张图太大了。试试先压缩到 8MB 以下?";
    case "BLOCKED":
      return (err as { message?: string })?.message ?? "这张图被规则拦下了。";
    case "ALL_PROVIDERS_FAILED":
    default:
      return "抱歉,几个视觉服务都没接上。直接告诉我酒名试试?";
  }
}