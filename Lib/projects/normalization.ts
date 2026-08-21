import {
  isProjectStatus,
} from "./validation.ts";
import { buildProjectJournalMediaPath, isProjectJournalMediaMimeType, isUuid, mediaTypeForMime } from "./mediaPaths.ts";
import { validateProjectJournalMediaMetadata } from "./mediaValidation.ts";
import type {
  ExpeditionProject,
  ExpeditionProjectSummary,
  ProjectDay,
  ProjectJournalEntry,
  ProjectJournalMedia,
  ProjectMountain,
} from "./types.ts";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? value as UnknownRecord : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizationFieldType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function rejectJournalMedia(reason: string, fieldValue: unknown): null {
  if (process.env.NODE_ENV === "development") {
    console.info("[ProjectMediaDisplay DEV][normalization-rejection]", {
      reason,
      fieldType: normalizationFieldType(fieldValue),
    });
  }
  return null;
}

function relationCount(value: unknown): number {
  const first = record(rows(value)[0]);
  return finiteNumber(first?.count) ?? 0;
}

export function normalizeProjectMountain(value: unknown): ProjectMountain | null {
  const membership = record(value);
  const mountain = record(membership?.mountains);
  const id = finiteNumber(mountain?.id);
  const heightM = finiteNumber(mountain?.height);
  const sortOrder = finiteNumber(membership?.sort_order);
  if (id === null || heightM === null || sortOrder === null) return null;
  return {
    id,
    name: stringValue(mountain?.name),
    nameDe: stringValue(mountain?.name_de),
    heightM,
    latitude: finiteNumber(mountain?.latitude),
    longitude: finiteNumber(mountain?.longitude),
    sortOrder,
  };
}

function normalizeDay(value: unknown, mountainsById: ReadonlyMap<number, ProjectMountain>): ProjectDay | null {
  const day = record(value);
  const id = stringValue(day?.id);
  const projectId = stringValue(day?.project_id);
  const dayNumber = finiteNumber(day?.day_number);
  const createdAt = stringValue(day?.created_at);
  const updatedAt = stringValue(day?.updated_at);
  if (!id || !projectId || !Number.isInteger(dayNumber) || dayNumber! < 1 || !createdAt || !updatedAt) return null;
  const assigned = rows(day?.expedition_project_day_mountains)
    .map((entry) => {
      const assignment = record(entry);
      const mountainId = finiteNumber(assignment?.mountain_id);
      const mountain = mountainId === null ? null : mountainsById.get(mountainId);
      if (!mountain) return null;
      return { ...mountain, sortOrder: finiteNumber(assignment?.sort_order) ?? mountain.sortOrder };
    })
    .filter((entry): entry is ProjectMountain => entry !== null)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  return {
    id,
    projectId,
    dayNumber: dayNumber!,
    date: stringValue(day?.date),
    title: stringValue(day?.title),
    notes: stringValue(day?.notes),
    mountains: assigned,
    trackEvidence: [],
    createdAt,
    updatedAt,
  };
}

function normalizeJournalEntry(value: unknown): ProjectJournalEntry | null {
  const entry = record(value);
  const id = stringValue(entry?.id);
  const projectId = stringValue(entry?.project_id);
  const userId = stringValue(entry?.user_id);
  const projectDayId = entry?.project_day_id === null || entry?.project_day_id === undefined
    ? null
    : stringValue(entry.project_day_id);
  const entryDate = stringValue(entry?.entry_date);
  const body = stringValue(entry?.body);
  const createdAt = stringValue(entry?.created_at);
  const updatedAt = stringValue(entry?.updated_at);
  if (!id || !projectId || !userId || !entryDate || body === null || !createdAt || !updatedAt || projectDayId === null && entry?.project_day_id != null) return null;
  const media = rows(entry?.expedition_project_journal_media)
    .map(normalizeJournalMedia)
    .filter((item): item is ProjectJournalMedia => {
      if (item === null) return false;
      if (item.journalEntryId !== id) {
        rejectJournalMedia("parent-journal-entry-id-mismatch", item.journalEntryId);
        return false;
      }
      if (item.projectId !== projectId) {
        rejectJournalMedia("parent-project-id-mismatch", item.projectId);
        return false;
      }
      if (item.userId !== userId) {
        rejectJournalMedia("parent-user-id-mismatch", item.userId);
        return false;
      }
      return true;
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (!body.trim() && media.length === 0) return null;
  return { id, projectId, userId, projectDayId, entryDate, title: stringValue(entry?.title), body, media, createdAt, updatedAt };
}

// Invalid nested media is discarded independently so one malformed attachment
// never removes an otherwise valid journal entry from the project response.
export function normalizeJournalMedia(value: unknown): ProjectJournalMedia | null {
  const media = record(value);
  if (!media) return rejectJournalMedia("invalid-row-shape", value);
  const id = stringValue(media?.id);
  const journalEntryId = stringValue(media?.journal_entry_id);
  const projectId = stringValue(media?.project_id);
  const userId = stringValue(media?.user_id);
  const mediaType = stringValue(media?.media_type);
  const storagePath = stringValue(media?.storage_path);
  const originalFilename = stringValue(media?.original_filename);
  const mimeType = stringValue(media?.mime_type);
  const sizeBytes = finiteNumber(media?.size_bytes);
  const width = finiteNumber(media?.width);
  const height = finiteNumber(media?.height);
  const durationSeconds = media?.duration_seconds === null ? null : finiteNumber(media?.duration_seconds);
  const sortOrder = finiteNumber(media?.sort_order);
  const createdAt = stringValue(media?.created_at);
  if (!id) return rejectJournalMedia("invalid-media-id", media.id);
  if (!journalEntryId) return rejectJournalMedia("invalid-journal-entry-id", media.journal_entry_id);
  if (!projectId) return rejectJournalMedia("invalid-project-id", media.project_id);
  if (!userId) return rejectJournalMedia("invalid-user-id", media.user_id);
  if (!storagePath) return rejectJournalMedia("invalid-storage-path", media.storage_path);
  if (!originalFilename) return rejectJournalMedia("invalid-original-filename", media.original_filename);
  if (!mimeType) return rejectJournalMedia("invalid-mime-type", media.mime_type);
  if (!mediaType) return rejectJournalMedia("invalid-media-type", media.media_type);
  if (sizeBytes === null) return rejectJournalMedia("invalid-size-bytes-type", media.size_bytes);
  if (width === null) return rejectJournalMedia("invalid-width-type", media.width);
  if (height === null) return rejectJournalMedia("invalid-height-type", media.height);
  if (sortOrder === null) return rejectJournalMedia("invalid-sort-order-type", media.sort_order);
  if (!createdAt) return rejectJournalMedia("invalid-created-at", media.created_at);
  if (!isUuid(id)) return rejectJournalMedia("invalid-media-id-uuid", media.id);
  if (!isUuid(journalEntryId)) return rejectJournalMedia("invalid-journal-entry-id-uuid", media.journal_entry_id);
  if (!isUuid(projectId)) return rejectJournalMedia("invalid-project-id-uuid", media.project_id);
  if (!isUuid(userId)) return rejectJournalMedia("invalid-user-id-uuid", media.user_id);
  if (!originalFilename.trim() || originalFilename.length > 255) {
    return rejectJournalMedia("invalid-original-filename-contract", media.original_filename);
  }
  if (storagePath.length > 1024) return rejectJournalMedia("invalid-storage-path-length", media.storage_path);
  if (!isProjectJournalMediaMimeType(mimeType)) return rejectJournalMedia("unsupported-mime-type", media.mime_type);
  if (mediaTypeForMime(mimeType) !== mediaType) return rejectJournalMedia("media-type-mime-mismatch", media.media_type);
  const validated = validateProjectJournalMediaMetadata({ mimeType, sizeBytes, width, height, durationSeconds, sortOrder });
  if (!validated.ok) {
    const rejectedField = validated.reason === "invalid-sort-order" ? media.sort_order
      : validated.reason === "invalid-mime" ? media.mime_type
        : validated.reason.includes("duration") ? media.duration_seconds
          : validated.reason.includes("dimensions") || validated.reason.includes("pixels") ? media.width
            : media.size_bytes;
    return rejectJournalMedia(`metadata-${validated.reason}`, rejectedField);
  }
  if (buildProjectJournalMediaPath({ userId, projectId, journalEntryId, mediaId: id, mimeType }) !== storagePath) {
    return rejectJournalMedia("invalid-storage-path-canonical", media.storage_path);
  }
  return {
    id, journalEntryId, projectId, userId, mediaType: validated.data.mediaType,
    storagePath, originalFilename, mimeType, sizeBytes, width, height,
    durationSeconds, sortOrder, createdAt,
  };
}

function normalizeProjectBase(value: unknown) {
  const project = record(value);
  const id = stringValue(project?.id);
  const userId = stringValue(project?.user_id);
  const name = stringValue(project?.name);
  const status = project?.status;
  const createdAt = stringValue(project?.created_at);
  const updatedAt = stringValue(project?.updated_at);
  if (!project || !id || !userId || !name || !isProjectStatus(status) || !createdAt || !updatedAt) return null;
  const mountains = rows(project.expedition_project_mountains)
    .map(normalizeProjectMountain)
    .filter((mountain): mountain is ProjectMountain => mountain !== null)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  return {
    project,
    base: {
      id,
      userId,
      name,
      description: stringValue(project.description),
      status,
      startDate: stringValue(project.start_date),
      endDate: stringValue(project.end_date),
      mountains,
      createdAt,
      updatedAt,
    },
  };
}

export function normalizeProjectSummary(value: unknown): ExpeditionProjectSummary | null {
  const normalized = normalizeProjectBase(value);
  if (!normalized) return null;
  return {
    ...normalized.base,
    dayCount: relationCount(normalized.project.expedition_project_days),
    journalEntryCount: relationCount(normalized.project.expedition_project_journal_entries),
  };
}

export function normalizeProjectDetail(value: unknown): ExpeditionProject | null {
  const normalized = normalizeProjectBase(value);
  if (!normalized) return null;
  const mountainsById = new Map(normalized.base.mountains.map((mountain) => [mountain.id, mountain]));
  const days = rows(normalized.project.expedition_project_days)
    .map((day) => normalizeDay(day, mountainsById))
    .filter((day): day is ProjectDay => day !== null)
    .sort((a, b) => a.dayNumber - b.dayNumber);
  const journalEntries = rows(normalized.project.expedition_project_journal_entries)
    .map(normalizeJournalEntry)
    .filter((entry): entry is ProjectJournalEntry => entry !== null)
    .sort((a, b) => b.entryDate.localeCompare(a.entryDate) || b.id.localeCompare(a.id));
  return { ...normalized.base, days, journalEntries };
}
