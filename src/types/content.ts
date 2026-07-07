/**
 * ContentBlock — 统一内容块类型
 *
 * 覆盖文本、JSON、图片、二进制引用和后端私有内容。
 */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "json"; json: unknown }
  | { type: "image"; imageUrl: string }
  | { type: "binary_ref"; ref: string }
  | { type: "opaque"; payload: unknown };
