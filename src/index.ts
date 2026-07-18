/**
 * @codehz/ai — 统一流式 AI 客户端
 *
 * 对外只暴露一个 canonical 主入口：client.stream()
 *
 * 分层：types → runtime → stream → canonical → provider → adapters
 */

// Re-export all canonical types
export * from "./types/index.js";

// Runtime: client / normalize / validate / errors
export * from "./runtime/index.js";

// Stream: event factory / aggregator / collect
export * from "./stream/index.js";

// Canonical constructors & pure mapping helpers
export * from "./canonical/index.js";

// Provider infrastructure (still re-exported in Phase 2; tightened in Phase 3)
export * from "./provider/index.js";

// Adapters
export * from "./adapters/index.js";
