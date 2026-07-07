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
 * const { events, rest } = parseSSEEvents(buffer);
 * for (const ev of events) {
 *   // ev.type — 事件类型字符串
 *   // ev.data — 已解析的 JSON 数据
 * }
 * // rest 是未处理的剩余 buffer，需要累积到下次调用
 * ```
 */

export type SSEEvent = { type: string; data: unknown };

export type SSEParseResult = {
  events: SSEEvent[];
  rest: string;
};

/**
 * 将 SSE 文本块解析为事件数组。
 * 累积事件行直到遇到空行，支持 [DONE] 标记。
 * 返回已解析的事件和未处理的剩余 buffer（用于增量解析）。
 *
 * 关键行为：
 * - 只解析完整的 event（以空行结尾）
 * - 未完成的行保留在 rest 中，等待下次 chunk 补全
 * - 支持跨 chunk 的 event 分片
 */
export function parseSSEEvents(chunk: string): SSEParseResult {
  const events: SSEEvent[] = [];
  let eventType = "";
  let dataLines: string[] = [];
  let lastEventEnd = 0;

  const lines = chunk.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("event: ")) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      dataLines.push(line.slice(6));
    } else if (line === "" && eventType && dataLines.length > 0) {
      // 完整的 event（以空行结尾）
      const dataStr = dataLines.join("\n");
      if (dataStr === "[DONE]") {
        eventType = "";
        dataLines = [];
        lastEventEnd = i + 1;
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
      lastEventEnd = i + 1;
    }
  }

  // 计算剩余 buffer：从最后一个完整 event 结束位置开始
  const rest = lines.slice(lastEventEnd).join("\n");

  // 如果有未完成的 event（有 eventType 或 dataLines 但没遇到空行），
  // 把这些也保留在 rest 中
  if (eventType || dataLines.length > 0) {
    let pending = "";
    if (eventType) pending += `event: ${eventType}\n`;
    for (const dl of dataLines) {
      pending += `data: ${dl}\n`;
    }
    return { events, rest: pending + rest };
  }

  return { events, rest };
}
