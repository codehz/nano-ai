/**
 * Mock 请求期望校验
 */

import { AIRequestError } from "../../runtime/errors.js";
import type {
  ContentBlock,
  InputItem,
  NormalizedRequest,
  ReplayItem,
  ToolResultItem,
} from "../../types/index.js";
import type {
  MockHandlerContext,
  MockInputExpectation,
  MockRequestExpectation,
} from "./types.js";

export function assertMockRequest(
  request: NormalizedRequest,
  expectation: MockRequestExpectation,
  context: MockHandlerContext,
): void {
  const prefix = `MockAdapter turn ${context.turnIndex + 1} expectation failed`;

  if (expectation.minItems !== undefined && request.input.length < expectation.minItems) {
    throw new AIRequestError(
      `${prefix}: expected at least ${expectation.minItems} input item(s)`,
      "MOCK_EXPECTATION_FAILED",
    );
  }

  if (expectation.maxItems !== undefined && request.input.length > expectation.maxItems) {
    throw new AIRequestError(
      `${prefix}: expected at most ${expectation.maxItems} input item(s)`,
      "MOCK_EXPECTATION_FAILED",
    );
  }

  if (expectation.tools === "present" && (!request.tools || request.tools.length === 0)) {
    throw new AIRequestError(`${prefix}: expected tools to be present`, "MOCK_EXPECTATION_FAILED");
  }

  if (expectation.tools === "absent" && request.tools && request.tools.length > 0) {
    throw new AIRequestError(`${prefix}: expected tools to be absent`, "MOCK_EXPECTATION_FAILED");
  }

  if (expectation.toolChoice === "present" && request.toolChoice === undefined) {
    throw new AIRequestError(`${prefix}: expected toolChoice to be present`, "MOCK_EXPECTATION_FAILED");
  }

  if (expectation.toolChoice === "absent" && request.toolChoice !== undefined) {
    throw new AIRequestError(`${prefix}: expected toolChoice to be absent`, "MOCK_EXPECTATION_FAILED");
  }

  if (expectation.requireReplayFromPreviousTurn && context.previousReplay.length > 0) {
    assertReplayIncluded(request.input, context.previousReplay, prefix);
  }

  if (expectation.requireToolResultsForPendingCalls && context.pendingToolCalls.length > 0) {
    const toolResultIds = new Set(
      request.input.filter((item): item is ToolResultItem => item.type === "tool_result").map((item) => item.callId),
    );

    for (const call of context.pendingToolCalls) {
      if (!toolResultIds.has(call.id)) {
        throw new AIRequestError(
          `${prefix}: expected tool_result for pending tool call "${call.id}"`,
          "MOCK_EXPECTATION_FAILED",
        );
      }
    }
  }

  if (expectation.items && expectation.items.length > 0) {
    if (expectation.ordered) {
      assertOrderedItems(request.input, expectation.items, prefix);
    } else {
      assertUnorderedItems(request.input, expectation.items, prefix);
    }
  }
}


export function assertReplayIncluded(input: readonly InputItem[], replay: readonly ReplayItem[], prefix: string): void {
  const fingerprints = input.map(fingerprintItem);
  let cursor = 0;

  for (const replayItem of replay) {
    const target = fingerprintItem(replayItem);
    const foundIndex = fingerprints.indexOf(target, cursor);
    if (foundIndex === -1) {
      throw new AIRequestError(
        `${prefix}: previous replay item was not carried into the next request`,
        "MOCK_EXPECTATION_FAILED",
      );
    }
    cursor = foundIndex + 1;
  }
}

export function assertOrderedItems(
  input: readonly InputItem[],
  expectations: readonly MockInputExpectation[],
  prefix: string,
): void {
  let cursor = 0;

  for (const expected of expectations) {
    let matched = false;
    while (cursor < input.length) {
      const item = input[cursor];
      if (item !== undefined && matchesItemExpectation(item, expected)) {
        matched = true;
        cursor += 1;
        break;
      }
      cursor += 1;
    }

    if (!matched) {
      throw new AIRequestError(
        `${prefix}: missing ordered input item ${describeExpectation(expected)}`,
        "MOCK_EXPECTATION_FAILED",
      );
    }
  }
}

export function assertUnorderedItems(
  input: readonly InputItem[],
  expectations: readonly MockInputExpectation[],
  prefix: string,
): void {
  for (const expected of expectations) {
    const matched = input.some((item) => matchesItemExpectation(item, expected));
    if (!matched) {
      throw new AIRequestError(
        `${prefix}: missing input item ${describeExpectation(expected)}`,
        "MOCK_EXPECTATION_FAILED",
      );
    }
  }
}

export function matchesItemExpectation(item: InputItem, expected: MockInputExpectation): boolean {
  if (item.type !== expected.type) {
    return false;
  }

  if (expected.id !== undefined && "id" in item && item.id !== expected.id) {
    return false;
  }

  switch (item.type) {
    case "message":
      return (
        (expected.role === undefined || item.role === expected.role) && matchesText(item.content, expected.textIncludes)
      );
    case "reasoning":
      return (
        (expected.visibility === undefined || item.visibility === expected.visibility) &&
        matchesText(item.content, expected.textIncludes)
      );
    case "tool_call":
      return (
        (expected.name === undefined || item.name === expected.name) &&
        (expected.textIncludes === undefined || item.argumentsText.includes(expected.textIncludes))
      );
    case "tool_result":
      return (
        (expected.toolName === undefined || item.toolName === expected.toolName) &&
        (expected.callId === undefined || item.callId === expected.callId) &&
        (expected.outcome === undefined || item.outcome === expected.outcome) &&
        matchesText(item.content, expected.textIncludes)
      );
    case "opaque":
      return (
        (expected.source === undefined || item.source === expected.source) &&
        (expected.purpose === undefined || item.purpose === expected.purpose)
      );
  }
}

export function matchesText(blocks: readonly ContentBlock[], textIncludes: string | undefined): boolean {
  if (textIncludes === undefined) {
    return true;
  }

  return blocks.some((block) => {
    if (block.type === "text") return block.text.includes(textIncludes);
    if (block.type === "json") return JSON.stringify(block.json).includes(textIncludes);
    return false;
  });
}

export function fingerprintItem(item: InputItem): string {
  return JSON.stringify(item);
}

export function describeExpectation(expectation: MockInputExpectation): string {
  const parts = [`type=${expectation.type}`];
  if (expectation.role) parts.push(`role=${expectation.role}`);
  if (expectation.name) parts.push(`name=${expectation.name}`);
  if (expectation.toolName) parts.push(`toolName=${expectation.toolName}`);
  if (expectation.callId) parts.push(`callId=${expectation.callId}`);
  if (expectation.textIncludes) parts.push(`textIncludes=${JSON.stringify(expectation.textIncludes)}`);
  return `{ ${parts.join(", ")} }`;
}

export function cloneItem<T>(item: T): T {
  return structuredClone(item);
}

