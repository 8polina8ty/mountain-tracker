import { isUuid } from "./mediaPaths.ts";

export type PhotoRendition = "thumb" | "display";
export const photoRenditions = {
  thumb: { bucket: "expedition-media-thumbnails", side: 256, bytes: 65_536 },
  display: { bucket: "expedition-media-display", side: 2048, bytes: 524_288 },
} as const;

export function renditionAttemptId(variant: PhotoRendition, mediaId: string, key: string) {
  const [prefix, version, name, extra] = key.split("/");
  return prefix === mediaId && isUuid(prefix) && (version === "v1" || (variant === "thumb" && version === "v2"))
    && extra === undefined && name?.endsWith(".webp") && isUuid(name.slice(0, -5)) ? name.slice(0, -5) : null;
}

// Reject metadata, animation and unknown chunks, including on previously stored copies.
export function isSanitizedPhotoWebp(bytes: Uint8Array) {
  if (bytes.byteLength < 20) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.toString("ascii", 0, 4) !== "RIFF" || view.toString("ascii", 8, 12) !== "WEBP"
    || view.readUInt32LE(4) + 8 !== view.length) return false;

  let images = 0;
  let alpha = false;
  let offset = 12;
  while (offset + 8 <= view.length) {
    const chunk = view.toString("latin1", offset, offset + 4);
    const length = view.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length & 1);
    if (end > view.length || length === 0) return false;
    if (chunk === "VP8X") {
      if (offset !== 12 || length !== 10 || (view[offset + 8] & ~0x10) !== 0) return false;
    } else if (chunk === "ALPH") {
      if (alpha || images !== 0) return false;
      alpha = true;
    } else if (chunk === "VP8 " || chunk === "VP8L") {
      if (++images !== 1) return false;
    } else {
      return false;
    }
    offset = end;
  }
  return offset === view.length && images === 1;
}
