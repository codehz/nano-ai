/**
 * Mock Adapter
 *
 * 用于本地调试 / UI 联调。
 * 按规则匹配请求中的关键词，命中后返回配置好的输出模板。
 */

import { AdapterBase } from "../helpers/adapter-base.js";
import { messageItem, replayFromOutput, textBlock } from "../helpers/mapping.js";
import { CAPABILITY_MATRIX } from "../types/adapter.js";

import type {
  AIStreamEvent,
  ContentBlock,
  EventFactory,
  MessageItem,
  NormalizedRequest,
  OutputItem,
  StopReason,
  ToolCallItem,
} from "../index.js";

export type MockResponseTemplate = string | ContentBlock[] | OutputItem | OutputItem[];

export type MockKeywordRule = {
  keywords: string[];
  response: MockResponseTemplate;
  caseSensitive?: boolean;
};

export type MockAdapterOptions = {
  rules?: MockKeywordRule[];
  defaultResponse?: MockResponseTemplate;
  providerMetadata?: Record<string, unknown>;
};

type MockProviderRequest = {
  matchedRule?: MockKeywordRule;
  responseTemplate: MockResponseTemplate;
  matchedKeyword?: string;
  extractedText: string;
};

function normalizeMessageTemplate(template: string | ContentBlock[] | MessageItem): MessageItem {
  if (typeof template === "string") {
    return messageItem([textBlock(template)]);
  }

  if (Array.isArray(template)) {
    return messageItem(template);
  }

  return {
    ...template,
    role: "assistant",
  };
}

function isContentBlock(value: unknown): value is ContentBlock {
  return typeof value === "object" && value !== null && "type" in value;
}

function isContentBlockArray(value: MockResponseTemplate): value is ContentBlock[] {
  return Array.isArray(value) && value.every((item) => isContentBlock(item) && !isOutputItemType(item.type));
}

function isOutputItemType(type: string): type is OutputItem["type"] {
  return type === "message" || type === "reasoning" || type === "tool_call" || type === "opaque";
}

function normalizeTemplate(template: MockResponseTemplate): OutputItem[] {
  if (typeof template === "string" || isContentBlockArray(template)) {
    return [normalizeMessageTemplate(template)];
  }

  if (Array.isArray(template)) {
    return template.map(normalizeOutputItem);
  }

  return [normalizeOutputItem(template)];
}

function normalizeOutputItem(item: OutputItem): OutputItem {
  if (item.type === "message") {
    return {
      ...item,
      role: "assistant",
    };
  }

  return item;
}

function isToolCallItem(item: OutputItem): item is ToolCallItem {
  return item.type === "tool_call";
}

function resolveStopReason(output: OutputItem[]): StopReason {
  return output.some(isToolCallItem) ? "tool_call" : "end_turn";
}

function extractRequestText(request: NormalizedRequest): string {
  return request.input
    .filter((item): item is Extract<NormalizedRequest["input"][number], { type: "message" }> => item.type === "message")
    .flatMap((item) => item.content)
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "json") return JSON.stringify(block.json);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function matchKeywordRule(text: string, rules: MockKeywordRule[]): { rule?: MockKeywordRule; keyword?: string } {
  for (const rule of rules) {
    for (const keyword of rule.keywords) {
      const haystack = rule.caseSensitive ? text : text.toLowerCase();
      const needle = rule.caseSensitive ? keyword : keyword.toLowerCase();
      if (needle.length > 0 && haystack.includes(needle)) {
        return { rule, keyword };
      }
    }
  }

  return {};
}

export class MockAdapter extends AdapterBase {
  readonly kind = "mock" as const;
  readonly capabilities = CAPABILITY_MATRIX.mock;

  private rules: MockKeywordRule[];
  private defaultResponse: MockResponseTemplate;
  private providerMetadata?: Record<string, unknown>;

  constructor(options: MockAdapterOptions = {}) {
    super();
    this.rules = options.rules ?? [];
    this.defaultResponse = options.defaultResponse ?? "Mock backend: no rule matched.";
    this.providerMetadata = options.providerMetadata;
  }

  protected buildRequest(request: NormalizedRequest): MockProviderRequest {
    const extractedText = extractRequestText(request);
    const { rule, keyword } = matchKeywordRule(extractedText, this.rules);

    return {
      matchedRule: rule,
      responseTemplate: rule?.response ?? this.defaultResponse,
      matchedKeyword: keyword,
      extractedText,
    };
  }

  protected async *runStream(
    providerRequest: unknown,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    const mockRequest = providerRequest as MockProviderRequest;
    const output = normalizeTemplate(mockRequest.responseTemplate).map((item, index) => attachSyntheticId(item, request, index));

    for (const item of output) {
      yield* this.emitOutputItem(factory, item);
    }

    const providerMetadata = {
      requestText: mockRequest.extractedText,
      matched: Boolean(mockRequest.matchedRule),
      matchedKeyword: mockRequest.matchedKeyword,
      configuredRules: this.rules.length,
      ...this.providerMetadata,
    };

    yield factory.responseCompleted(
      this.buildResponse(
        request,
        {
          output,
          replay: replayFromOutput(output),
          stopReason: resolveStopReason(output),
          providerMetadata,
          metadataSources: ["mock"],
        },
        factory,
      ),
    );
  }

  private async *emitOutputItem(factory: EventFactory, item: OutputItem): AsyncIterable<AIStreamEvent> {
    if (item.type === "message") {
      yield factory.messageStarted(item.id!);

      for (const block of item.content) {
        if (block.type === "text") {
          yield factory.messageDelta(item.id!, block.text);
        }
      }

      yield factory.messageCompleted(item);
      return;
    }

    if (item.type === "tool_call") {
      yield factory.toolCallStarted(item.id, item.name);
      if (item.argumentsText) {
        yield factory.toolCallDelta(item.id, { argumentsText: item.argumentsText });
      }
      yield factory.toolCallCompleted(item);
    }
  }
}

function attachSyntheticId(item: OutputItem, request: NormalizedRequest, index: number): OutputItem {
  if (item.type === "message") {
    return {
      ...item,
      id: item.id ?? `mock-msg-${request.requestId}-${index}`,
      role: "assistant",
    };
  }

  if (item.type === "reasoning") {
    return {
      ...item,
      id: item.id ?? `mock-reason-${request.requestId}-${index}`,
    };
  }

  if (item.type === "opaque") {
    return {
      ...item,
      id: item.id ?? `mock-opaque-${request.requestId}-${index}`,
    };
  }

  return item;
}
