/**
 * ContentBlock — 统一内容块类型
 *
 * 覆盖文本、JSON、图片、二进制引用和后端私有内容。
 */

export type TextContentBlock = { type: "text"; text: string };
export type JsonContentBlock = { type: "json"; json: unknown };
export type InstructionBlock = TextContentBlock | JsonContentBlock;

export type ContentBlock =
  | InstructionBlock
  | { type: "image"; imageUrl: string }
  | { type: "binary_ref"; ref: string }
  | { type: "opaque"; payload: unknown };
