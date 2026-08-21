import {
  isProjectJournalMediaMimeType,
  mediaTypeForMime,
  type ProjectJournalMediaMimeType,
} from "./mediaPaths.ts";
import type {
  ProjectJournalMediaType,
  ProjectJournalMediaValidationResult,
} from "./types.ts";

export const PROJECT_JOURNAL_MEDIA_MAX_ITEMS = 12;
export const PROJECT_JOURNAL_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const PROJECT_JOURNAL_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const PROJECT_JOURNAL_PHOTO_MAX_WIDTH = 8192;
export const PROJECT_JOURNAL_PHOTO_MAX_HEIGHT = 8192;
export const PROJECT_JOURNAL_PHOTO_MAX_PIXELS = 40_000_000;
export const PROJECT_JOURNAL_VIDEO_MAX_WIDTH = 3840;
export const PROJECT_JOURNAL_VIDEO_MAX_HEIGHT = 2160;
export const PROJECT_JOURNAL_VIDEO_MAX_DURATION_SECONDS = 300;

export type ProjectJournalMediaMetadata = {
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationSeconds: number | null;
  sortOrder: number;
};

export type InspectedProjectJournalMedia = ProjectJournalMediaMetadata & {
  mimeType: ProjectJournalMediaMimeType;
  mediaType: ProjectJournalMediaType;
};

export function validateProjectJournalMediaMetadata(
  metadata: ProjectJournalMediaMetadata,
): ProjectJournalMediaValidationResult<InspectedProjectJournalMedia> {
  if (!isProjectJournalMediaMimeType(metadata.mimeType)) return { ok: false, reason: "invalid-mime" };
  if (!Number.isInteger(metadata.sizeBytes) || metadata.sizeBytes <= 0) return { ok: false, reason: "empty-file" };
  if (!Number.isInteger(metadata.sortOrder) || metadata.sortOrder < 0) return { ok: false, reason: "invalid-sort-order" };

  const mediaType = mediaTypeForMime(metadata.mimeType);
  const dimensionsValid = Number.isInteger(metadata.width) && metadata.width > 0
    && Number.isInteger(metadata.height) && metadata.height > 0;

  if (mediaType === "photo") {
    if (metadata.sizeBytes > PROJECT_JOURNAL_PHOTO_MAX_BYTES) return { ok: false, reason: "photo-too-large" };
    if (!dimensionsValid || metadata.width > PROJECT_JOURNAL_PHOTO_MAX_WIDTH || metadata.height > PROJECT_JOURNAL_PHOTO_MAX_HEIGHT) {
      return { ok: false, reason: "photo-dimensions" };
    }
    if (metadata.width * metadata.height > PROJECT_JOURNAL_PHOTO_MAX_PIXELS) return { ok: false, reason: "photo-pixels" };
    if (metadata.durationSeconds !== null) return { ok: false, reason: "photo-duration" };
  } else {
    if (metadata.sizeBytes > PROJECT_JOURNAL_VIDEO_MAX_BYTES) return { ok: false, reason: "video-too-large" };
    if (!dimensionsValid || metadata.width > PROJECT_JOURNAL_VIDEO_MAX_WIDTH || metadata.height > PROJECT_JOURNAL_VIDEO_MAX_HEIGHT) {
      return { ok: false, reason: "video-dimensions" };
    }
    if (!Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds! <= 0
      || metadata.durationSeconds! > PROJECT_JOURNAL_VIDEO_MAX_DURATION_SECONDS) {
      return { ok: false, reason: "video-duration" };
    }
  }

  return { ok: true, data: { ...metadata, mimeType: metadata.mimeType, mediaType } };
}

function bytesMatch(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

export async function hasExpectedProjectJournalMediaSignature(file: File): Promise<boolean> {
  if (!isProjectJournalMediaMimeType(file.type) || file.size <= 0) return false;
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  switch (file.type) {
    case "image/jpeg": return bytesMatch(bytes, [0xff, 0xd8, 0xff]);
    case "image/png": return bytesMatch(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp": return bytesMatch(bytes, [0x52, 0x49, 0x46, 0x46]) && bytesMatch(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case "video/mp4": return bytesMatch(bytes, [0x66, 0x74, 0x79, 0x70], 4);
    case "video/webm": return bytesMatch(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
  }
}

export async function validateProjectJournalMediaFile(
  file: File,
  metadata: Omit<ProjectJournalMediaMetadata, "mimeType" | "sizeBytes">,
): Promise<ProjectJournalMediaValidationResult<InspectedProjectJournalMedia>> {
  const validated = validateProjectJournalMediaMetadata({ ...metadata, mimeType: file.type, sizeBytes: file.size });
  if (!validated.ok) return validated;
  return await hasExpectedProjectJournalMediaSignature(file)
    ? validated
    : { ok: false, reason: "signature-mismatch" };
}

export async function inspectProjectJournalMediaFile(
  file: File,
  sortOrder: number,
): Promise<ProjectJournalMediaValidationResult<InspectedProjectJournalMedia>> {
  if (!isProjectJournalMediaMimeType(file.type)) return { ok: false, reason: "invalid-mime" };
  const sizeOnly = validateProjectJournalMediaMetadata({
    mimeType: file.type,
    sizeBytes: file.size,
    width: 1,
    height: 1,
    durationSeconds: mediaTypeForMime(file.type) === "video" ? 1 : null,
    sortOrder,
  });
  if (!sizeOnly.ok && ["empty-file", "photo-too-large", "video-too-large", "invalid-sort-order"].includes(sizeOnly.reason)) {
    return sizeOnly;
  }
  // Header signatures are a useful corruption/spoofing check, not trusted
  // cryptographic content inspection; Storage and database limits still apply.
  if (!(await hasExpectedProjectJournalMediaSignature(file))) return { ok: false, reason: "signature-mismatch" };

  if (mediaTypeForMime(file.type) === "photo") {
    if (typeof createImageBitmap !== "function") return { ok: false, reason: "decoding-unavailable" };
    try {
      const bitmap = await createImageBitmap(file);
      const metadata = { width: bitmap.width, height: bitmap.height, durationSeconds: null, sortOrder };
      bitmap.close();
      return validateProjectJournalMediaFile(file, metadata);
    } catch {
      return { ok: false, reason: "decode-failed" };
    }
  }

  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return { ok: false, reason: "decoding-unavailable" };
  }
  return await new Promise((resolve) => {
    const video = document.createElement("video");
    const objectUrl = URL.createObjectURL(file);
    let settled = false;
    const finish = (result: ProjectJournalMediaValidationResult<InspectedProjectJournalMedia>) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
      resolve(result);
    };
    const timeoutId = window.setTimeout(() => finish({ ok: false, reason: "decode-failed" }), 15_000);
    video.preload = "metadata";
    video.onloadedmetadata = () => void validateProjectJournalMediaFile(file, {
      width: video.videoWidth,
      height: video.videoHeight,
      durationSeconds: video.duration,
      sortOrder,
    }).then(finish);
    video.onerror = () => finish({ ok: false, reason: "decode-failed" });
    video.src = objectUrl;
  });
}
