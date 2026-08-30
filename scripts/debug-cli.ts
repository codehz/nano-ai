/**
 * API 调试 REPL：用环境变量选 adapter / 模型，逐条打印 canonical 流事件和报错。
 *
 * 不是通用客户端。不做聊天渲染、不执行 tool、不隐藏字段。
 *
 *   bun run scripts/debug-cli.ts
 *
 * 必填：NANO_AI_KIND、NANO_AI_MODEL
 * 其余见 /help
 */

import * as readline from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";

import {
  AIError,
  AIProviderError,
  AIRequestError,
  ChatCompletionsAdapter,
  DeltaCompletionsAdapter,
  GeminiAdapter,
  MessagesAdapter,
  OllamaAdapter,
  REASONING_LEVEL_SET,
  SERVICE_TIER_SET,
  ResponsesAdapter,
  createAIClient,
  messageItem,
  textBlock,
} from "../src/index.js";

import type {
  AIClient,
  BackendAdapter,
  IncludeSettings,
  InputItem,
  ReasoningLevel,
  ReplayItem,
  ServerToolDefinition,
  ServiceTier,
  ToolDefinition,
} from "../src/index.js";

const HTTP_KINDS = ["delta-completions", "chat-completions", "messages", "responses", "ollama", "gemini"] as const;
type HttpKind = (typeof HTTP_KINDS)[number];

const KIND_ALIASES: Record<string, HttpKind> = {
  "delta-completions": "delta-completions",
  "chat-completions": "chat-completions",
  chat: "chat-completions",
  openai: "chat-completions",
  "openai-chat": "chat-completions",
  responses: "responses",
  "openai-responses": "responses",
  messages: "messages",
  anthropic: "messages",
  claude: "messages",
  ollama: "ollama",
  gemini: "gemini",
  google: "gemini",
};

type DebugConfig = {
  kind: HttpKind;
  model: string;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  headers: Record<string, string> | undefined;
  extraBody: Record<string, unknown> | undefined;
  apiVersion: string | undefined;
  instructions: string | undefined;
  temperature: number | undefined;
  maxOutputTokens: number | undefined;
  reasoningLevel: ReasoningLevel | undefined;
  serviceTier: ServiceTier | undefined;
  include: IncludeSettings;
  tools: ToolDefinition[] | undefined;
  serverTools: ServerToolDefinition[] | undefined;
};

function fail(message: string): never {
  stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function env(name: string): string | undefined {
  const value = process.env[name];
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function envJson(name: string): unknown {
  const raw = env(name);
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function envObject(name: string): Record<string, unknown> | undefined {
  const value = envJson(name);
  if (value == null) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function envStringRecord(name: string): Record<string, string> | undefined {
  const value = envObject(name);
  if (value == null) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") fail(`${name}.${key} must be a string`);
    out[key] = entry;
  }
  return out;
}

function envNumber(name: string): number | undefined {
  const raw = env(name);
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`${name} must be a finite number`);
  return value;
}

function requireApiKey(kind: HttpKind, apiKey: string | undefined): string {
  if (apiKey) return apiKey;
  fail(`${kind} requires NANO_AI_API_KEY (or the provider fallback key)`);
}

function resolveKind(raw: string | undefined): HttpKind {
  if (raw == null) fail("NANO_AI_KIND is required (chat-completions | messages | responses | ollama | gemini)");
  const kind = KIND_ALIASES[raw.toLowerCase()];
  if (kind == null) {
    fail(`unknown NANO_AI_KIND=${raw}; expected ${HTTP_KINDS.join(" | ")} (or aliases chat/anthropic/gemini/...)`);
  }
  return kind;
}

function resolveApiKey(kind: HttpKind): string | undefined {
  const explicit = env("NANO_AI_API_KEY");
  if (explicit) return explicit;
  switch (kind) {
    case "chat-completions":
    case "responses":
      return env("OPENAI_API_KEY");
    case "messages":
      return env("ANTHROPIC_API_KEY");
    case "gemini":
      return env("GEMINI_API_KEY");
    case "ollama":
      return undefined;
  }
}

function resolveInclude(): IncludeSettings {
  const raw = envObject("NANO_AI_INCLUDE");
  if (raw) return raw as IncludeSettings;
  return {
    usage: "best_effort",
    billing: "best_effort",
    providerMetadata: "best_effort",
  };
}

function resolveReasoningLevel(): ReasoningLevel | undefined {
  const raw = env("NANO_AI_REASONING_LEVEL");
  if (raw == null) return undefined;
  if (!REASONING_LEVEL_SET.has(raw)) {
    fail(`unknown NANO_AI_REASONING_LEVEL=${raw}`);
  }
  return raw as ReasoningLevel;
}

function resolveServiceTier(): ServiceTier | undefined {
  const raw = env("NANO_AI_SERVICE_TIER");
  if (raw == null) return undefined;
  if (!SERVICE_TIER_SET.has(raw)) {
    fail(`unknown NANO_AI_SERVICE_TIER=${raw}`);
  }
  return raw as ServiceTier;
}

function loadConfig(): DebugConfig {
  const kind = resolveKind(env("NANO_AI_KIND"));
  const model = env("NANO_AI_MODEL");
  if (model == null) fail("NANO_AI_MODEL is required");

  return {
    kind,
    model,
    apiKey: resolveApiKey(kind),
    baseUrl: env("NANO_AI_BASE_URL"),
    headers: envStringRecord("NANO_AI_HEADERS"),
    extraBody: envObject("NANO_AI_EXTRA_BODY"),
    apiVersion: env("NANO_AI_API_VERSION"),
    instructions: env("NANO_AI_INSTRUCTIONS"),
    temperature: envNumber("NANO_AI_TEMPERATURE"),
    maxOutputTokens: envNumber("NANO_AI_MAX_OUTPUT_TOKENS"),
    reasoningLevel: resolveReasoningLevel(),
    serviceTier: resolveServiceTier(),
    include: resolveInclude(),
    tools: envJson("NANO_AI_TOOLS") as ToolDefinition[] | undefined,
    serverTools: envJson("NANO_AI_SERVER_TOOLS") as ServerToolDefinition[] | undefined,
  };
}

function createAdapter(config: DebugConfig): BackendAdapter {
  const http = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    headers: config.headers,
    extraBody: config.extraBody,
  };

  switch (config.kind) {
    case "delta-completions": {
      const baseUrl = http.baseUrl;
      if (!baseUrl) throw new Error("delta-completions requires baseUrl");
      return new DeltaCompletionsAdapter({
        ...http,
        baseUrl,
        apiKey: requireApiKey(config.kind, config.apiKey),
      });
    }
    case "chat-completions":
      return new ChatCompletionsAdapter({
        ...http,
        apiKey: requireApiKey(config.kind, config.apiKey),
      });
    case "responses":
      return new ResponsesAdapter({
        ...http,
        apiKey: requireApiKey(config.kind, config.apiKey),
      });
    case "messages":
      return new MessagesAdapter({
        ...http,
        apiKey: requireApiKey(config.kind, config.apiKey),
        apiVersion: config.apiVersion,
      });
    case "gemini":
      return new GeminiAdapter({
        ...http,
        apiKey: requireApiKey(config.kind, config.apiKey),
      });
    case "ollama":
      return new OllamaAdapter(http);
  }
}

function dumpJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function publicConfig(config: DebugConfig): Record<string, unknown> {
  const apiKey =
    config.apiKey == null
      ? "(unset)"
      : config.apiKey.length <= 8
        ? "***"
        : `${config.apiKey.slice(0, 4)}…${config.apiKey.slice(-4)}`;
  return {
    kind: config.kind,
    model: config.model,
    apiKey,
    baseUrl: config.baseUrl ?? "(adapter default)",
    headers: config.headers,
    extraBody: config.extraBody,
    apiVersion: config.apiVersion,
    instructions: config.instructions,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    reasoningLevel: config.reasoningLevel,
    serviceTier: config.serviceTier,
    include: config.include,
    tools: config.tools,
    serverTools: config.serverTools,
  };
}

function formatError(error: unknown): string {
  if (error instanceof AIProviderError) {
    return dumpJson({
      name: error.name,
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
      responseBody: error.responseBody,
      stack: error.stack,
    });
  }
  if (error instanceof AIRequestError) {
    return dumpJson({
      name: error.name,
      code: error.code,
      message: error.message,
      issues: error.issues,
      stack: error.stack,
    });
  }
  if (error instanceof AIError) {
    return dumpJson({
      name: error.name,
      code: error.code,
      message: error.message,
      stack: error.stack,
    });
  }
  if (error instanceof Error) {
    return dumpJson({
      name: error.name,
      message: error.message,
      cause: error.cause,
      stack: error.stack,
    });
  }
  return dumpJson({ error });
}

function helpText(): string {
  return `commands:
  /help         this text
  /config       print resolved env config (api key redacted)
  /transcript   print current input items
  /replay       print last response.completed.replay
  /reset        drop transcript + last replay
  /quit         exit

env:
  NANO_AI_KIND              chat-completions | messages | responses | ollama | gemini
  NANO_AI_MODEL             model id
  NANO_AI_API_KEY           optional; falls back to OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY
  NANO_AI_BASE_URL          optional
  NANO_AI_HEADERS           JSON object of extra headers
  NANO_AI_EXTRA_BODY        JSON object merged into wire body
  NANO_AI_API_VERSION       messages adapter only
  NANO_AI_INSTRUCTIONS      system instructions
  NANO_AI_TEMPERATURE       number
  NANO_AI_MAX_OUTPUT_TOKENS number
  NANO_AI_REASONING_LEVEL   none | minimal | low | medium | high | xhigh | max
  NANO_AI_SERVICE_TIER      auto | default | flex | fast | priority
  NANO_AI_INCLUDE           JSON IncludeSettings (default best_effort for usage/billing/providerMetadata)
  NANO_AI_TOOLS             JSON ToolDefinition[]
  NANO_AI_SERVER_TOOLS      JSON ServerToolDefinition[]

each non-command line is one user prompt. prior replay is appended so the next turn
exercises opaque/canonical continuation. /reset for a fresh request. every stream
event is printed as JSON; thrown errors dump name/code/status/body/stack.
`;
}

async function runTurn(
  client: AIClient,
  transcript: InputItem[],
  prompt: string,
  signal: AbortSignal,
): Promise<ReplayItem[] | undefined> {
  transcript.push(messageItem([textBlock(prompt)], { role: "user" }));

  stdout.write(`\n--- stream start ---\n`);
  let eventCount = 0;
  let replay: ReplayItem[] | undefined;

  try {
    for await (const event of client.stream({ input: transcript, signal })) {
      eventCount += 1;
      stdout.write(`\n#${eventCount} ${event.type} seq=${event.sequence}\n`);
      stdout.write(dumpJson(event));
      if (event.type === "response.completed") {
        replay = event.replay;
      }
    }
    stdout.write(`--- stream end events=${eventCount} ---\n`);
    if (replay) transcript.push(...replay);
    return replay;
  } catch (error) {
    stdout.write(`--- stream error after ${eventCount} events ---\n`);
    stderr.write(formatError(error));
    return replay;
  }
}

async function repl(config: DebugConfig, client: AIClient): Promise<void> {
  const transcript: InputItem[] = [];
  let lastReplay: ReplayItem[] | undefined;
  let abort: AbortController | undefined;
  let running = false;

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: stdin.isTTY,
  });

  rl.on("SIGINT", () => {
    if (running && abort && !abort.signal.aborted) {
      abort.abort();
      stderr.write("\naborted current stream\n");
      return;
    }
    rl.close();
  });

  stdout.write(`nano-ai debug-cli  kind=${config.kind}  model=${config.model}\n`);
  stdout.write(`type a prompt, or /help\n`);

  const handleLine = async (line: string): Promise<boolean> => {
    const trimmed = line.trim();
    if (trimmed === "") return true;
    if (trimmed === "/help") {
      stdout.write(helpText());
      return true;
    }
    if (trimmed === "/quit" || trimmed === "/exit") return false;
    if (trimmed === "/config") {
      stdout.write(dumpJson(publicConfig(config)));
      return true;
    }
    if (trimmed === "/transcript") {
      stdout.write(dumpJson(transcript));
      return true;
    }
    if (trimmed === "/replay") {
      stdout.write(dumpJson(lastReplay ?? null));
      return true;
    }
    if (trimmed === "/reset") {
      transcript.length = 0;
      lastReplay = undefined;
      stdout.write("transcript cleared\n");
      return true;
    }
    if (trimmed.startsWith("/")) {
      stderr.write(`unknown command: ${trimmed}  (/help)\n`);
      return true;
    }

    abort = new AbortController();
    running = true;
    try {
      lastReplay = await runTurn(client, transcript, line, abort.signal);
    } finally {
      running = false;
      abort = undefined;
    }
    return true;
  };

  if (!stdin.isTTY) {
    for await (const line of rl) {
      const keep = await handleLine(line);
      if (!keep) break;
    }
    rl.close();
    return;
  }

  while (true) {
    let line: string;
    try {
      line = await rl.question(`debug[${transcript.length}]> `);
    } catch {
      break;
    }
    const keep = await handleLine(line);
    if (!keep) break;
  }
  rl.close();
}

const config = loadConfig();
const adapter = createAdapter(config);
const client = createAIClient({
  adapter,
  model: config.model,
  defaults: {
    instructions: config.instructions,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    reasoningLevel: config.reasoningLevel,
    serviceTier: config.serviceTier,
    include: config.include,
    tools: config.tools,
    serverTools: config.serverTools,
  },
});

await repl(config, client);
