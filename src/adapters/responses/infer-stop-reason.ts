/**
 * Responses API 最终 payload → StopReason
 */

import type { StopReason } from "../../types/index.js";
import type { ResponsesAPIResponse } from "./types.js";

export function inferResponsesStopReason(response: ResponsesAPIResponse): StopReason {
  if (response.status === "failed") return "error";

  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    if (reason === "content_filter") return "content_filter";
    if (reason === "max_output_tokens") return "max_output_tokens";
    return "max_output_tokens";
  }

  const output = response.output;
  if (!output || output.length === 0) {
    return response.status === "completed" ? "end_turn" : "unknown";
  }

  const hasFunctionCall = output.some((item) => item.type === "function_call");
  if (hasFunctionCall) return "tool_call";

  const lastItem = output[output.length - 1];
  if (lastItem?.status === "failed") return "error";
  if (lastItem?.status === "incomplete") return "max_output_tokens";

  return "end_turn";
}
