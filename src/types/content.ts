/**
 * ContentBlock — 统一内容块类型
 *
 * 覆盖文本、JSON、图片、二进制引用和后端私有内容。
 */

/** 文本内容块；用于 instructions、消息内容和流增量。 */
export type TextContentBlock = { type: "text"; text: string };
/** JSON 内容块；`json` 保留调用方提供的任意 JSON 兼容值。 */
export type JsonContentBlock = { type: "json"; json: unknown };
/** 可作为请求 instructions 的内容块联合。 */
export type InstructionBlock = TextContentBlock | JsonContentBlock;

/**
 * 统一内容块：文本、JSON、图片、二进制引用或 provider 专有 opaque 数据。
 */
export type ContentBlock =
  | InstructionBlock
  | { type: "image"; imageUrl: string }
  | { type: "binary_ref"; ref: string }
  | { type: "opaque"; payload: unknown };
