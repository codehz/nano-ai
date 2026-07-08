/**
 * Mock Adapter
 *
 * 用于本地调试 / UI 联调。
 * 按规则匹配请求中的关键词，命中后返回配置好的回复模板。
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
} from "../index.js";

export type MockResponseTemplate = string | ContentBlock[] | MessageItem;

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

function normalizeTemplate(template: MockResponseTemplate): MessageItem {
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
    const id = `mock-msg-${request.requestId}`;
    const completedMessage: MessageItem = {
      ...normalizeTemplate(mockRequest.responseTemplate),
      type: "message",
      id,
      role: "assistant",
    };

    yield factory.messageStarted(id);

    for (const block of completedMessage.content) {
      if (block.type === "text") {
        yield factory.messageDelta(id, block.text);
      }
    }

    yield factory.messageCompleted(completedMessage);

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
          output: [completedMessage],
          replay: replayFromOutput([completedMessage]),
          stopReason: "end_turn",
          providerMetadata,
          metadataSources: ["mock"],
        },
        factory,
      ),
    );
  }
}
