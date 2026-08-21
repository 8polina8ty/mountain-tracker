import type { ProjectJournalMediaType } from "./types.ts";

export const EXPEDITION_MEDIA_BUCKET = "expedition-media";

export const PROJECT_MEDIA_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
] as const;

export type ProjectJournalMediaMimeType = (typeof PROJECT_MEDIA_MIME_TYPES)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MIME_CONTRACT: Record<ProjectJournalMediaMimeType, { extension: string; mediaType: ProjectJournalMediaType }> = {
  "image/jpeg": { extension: "jpg", mediaType: "photo" },
  "image/png": { extension: "png", mediaType: "photo" },
  "image/webp": { extension: "webp", mediaType: "photo" },
  "video/mp4": { extension: "mp4", mediaType: "video" },
  "video/webm": { extension: "webm", mediaType: "video" },
};

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isProjectJournalMediaMimeType(value: string): value is ProjectJournalMediaMimeType {
  return Object.hasOwn(MIME_CONTRACT, value);
}

export function canonicalExtensionForMime(mimeType: string): string | null {
  return isProjectJournalMediaMimeType(mimeType) ? MIME_CONTRACT[mimeType].extension : null;
}

export function mediaTypeForMime(mimeType: ProjectJournalMediaMimeType): ProjectJournalMediaType {
  return MIME_CONTRACT[mimeType].mediaType;
}

export function buildProjectJournalMediaPath(input: {
  userId: string;
  projectId: string;
  journalEntryId: string;
  mediaId: string;
  mimeType: string;
}): string | null {
  const identifiers = [input.userId, input.projectId, input.journalEntryId, input.mediaId];
  const extension = canonicalExtensionForMime(input.mimeType);
  if (!extension || identifiers.some((identifier) => !isUuid(identifier))) return null;
  return `${identifiers.join("/")}/original.${extension}`;
}
