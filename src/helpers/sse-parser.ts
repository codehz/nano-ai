/**
 * 通用 SSE (Server-Sent Events) 解析器
 *
 * 解析标准 SSE 格式（event: + data: 行），适用于：
 * - Anthropic Messages API (messages.ts)
 * - OpenAI Responses API (responses.ts)
 *
 * 注意：OpenAI Chat Completions API 使用简化 SSE（仅有 data: 行），
 * 由 chat-completions.ts 中的 parseChatSSE 处理。
 *
 * 用法：
 * ```ts
 * const events = parseSSEEvents(buffer);
 * for (const ev of events) {
 *   // ev.type — 事件类型字符串
 *   // ev.data — 已解析的 JSON 数据
 * }
 * ```
 */

export type SSEEvent = { type: string; data: unknown };

/**
 * 将 SSE 文本块解析为事件数组。
 * 累积事件行直到遇到空行，支持 [DONE] 标记。
 * 不保留 buffer 状态，调用者需自行管理缓冲区。
 */
export function parseSSEEvents(chunk: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  let eventType = "";
  let dataLines: string[] = [];

  for (const line of chunk.split("\n")) {
    if (line.startsWith("event: ")) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      dataLines.push(line.slice(6));
    } else if (line === "" && eventType && dataLines.length > 0) {
      const dataStr = dataLines.join("\n");
      if (dataStr === "[DONE]") {
        eventType = "";
        dataLines = [];
        continue;
      }
      try {
        const data = JSON.parse(dataStr);
        events.push({ type: eventType, data });
      } catch {
        // skip malformed JSON
      }
      eventType = "";
      dataLines = [];
    }
  }

  return events;
}
