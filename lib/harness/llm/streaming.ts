/**
 * SSE parser — turns a Node `ReadableStream<Uint8Array>` (the response body
 * from `fetch`) into an async iterable of parsed JSON chunks.
 *
 * The OpenAI chat-completions streaming wire format is:
 *
 *     data: {"choices":[{"delta":{"content":"hi"},"index":0}], ...}\n\n
 *     data: {"choices":[{"delta":{},"finish_reason":"stop"}], ...}\n\n
 *     data: [DONE]\n\n
 *
 * Lines starting with anything other than `data: ` are ignored. The
 * terminating `[DONE]` sentinel is dropped. Malformed JSON is skipped
 * silently — the caller already has partial content to work with.
 */

export interface ParsedSSEEvent {
  /** Raw event name if present (we only ever emit "data", but keep for future). */
  event: string;
  /** Parsed JSON payload, or null for non-JSON lines / [DONE]. */
  data: unknown;
}

const decoder = new TextDecoder("utf-8");

/**
 * Async-iterable SSE parser. Yields one event per logical SSE record.
 *
 * Reads the stream with a chunked decoder so multi-byte UTF-8 boundaries
 * across SSE line breaks are not corrupted.
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<ParsedSSEEvent> {
  const reader = stream.getReader();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE records are separated by a blank line.
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const record = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const ev of parseSSERecord(record)) yield ev;
      }
    }
    // Flush any trailing record that didn't end with \n\n.
    if (buf.trim()) {
      for (const ev of parseSSERecord(buf)) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}

function* parseSSERecord(record: string): Iterable<ParsedSSEEvent> {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of record.split("\n")) {
    if (!line) continue;
    if (line.startsWith(":")) continue; // comment
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return;
  const joined = dataLines.join("\n");
  if (joined === "[DONE]") return;
  let data: unknown;
  try {
    data = JSON.parse(joined);
  } catch {
    // Malformed JSON — drop the record entirely instead of yielding a
    // null-data event that downstream code would have to special-case.
    return;
  }
  yield { event, data };
}