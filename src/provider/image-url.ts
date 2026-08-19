/**
 * Pure imageUrl classification / data-URL parsing for adapter request mapping.
 * Never fetches network resources.
 */

export const SUPPORTED_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

export type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

export type ParsedImageDataUrl = {
  mediaType: SupportedImageMediaType;
  data: string;
};

const SUPPORTED_IMAGE_MEDIA_TYPE_SET = new Set<string>(SUPPORTED_IMAGE_MEDIA_TYPES);

/** True when imageUrl is an http(s) URL with a non-empty host. */
export function isHttpOrHttpsUrl(imageUrl: string): boolean {
  try {
    const url = new URL(imageUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host.length > 0;
  } catch {
    return false;
  }
}

/**
 * Parse `data:image/(jpeg|png|gif|webp);base64,<data>`.
 * Rejects other media types, non-base64 data URLs, and empty payloads.
 * Does not accept whitespace inside the base64 payload.
 */
export function parseImageDataUrl(imageUrl: string): ParsedImageDataUrl | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(imageUrl);
  if (!match) return null;

  const mediaType = match[1]?.trim().toLowerCase();
  const data = match[2];
  if (!mediaType || !data || !SUPPORTED_IMAGE_MEDIA_TYPE_SET.has(mediaType)) {
    return null;
  }

  return { mediaType: mediaType as SupportedImageMediaType, data };
}
