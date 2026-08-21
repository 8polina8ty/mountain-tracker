import type { SupabaseClient } from "@supabase/supabase-js";

import { buildProjectJournalMediaPath, EXPEDITION_MEDIA_BUCKET, isUuid } from "./mediaPaths.ts";
import { uploadProjectMediaObject, type ProjectMediaUploadController } from "./mediaUploadTransport.ts";
import { createProjectMediaDiagnostic, type ProjectMediaFailureStage } from "./mediaDiagnostics.ts";
import {
  PROJECT_JOURNAL_MEDIA_MAX_ITEMS,
  validateProjectJournalMediaFile,
} from "./mediaValidation.ts";
import type {
  ProjectJournalMedia,
  ProjectJournalMediaFailureReason,
  ProjectJournalMediaMutationResult,
  ProjectJournalMediaUploadInput,
} from "./types.ts";

type ErrorLike = { code?: unknown; message?: unknown; details?: unknown };

function failure(
  reason: ProjectJournalMediaFailureReason,
  message: string,
  retryable: boolean,
  stage: ProjectMediaFailureStage,
  error: unknown = null,
  cleanupSucceeded: boolean | null = null,
): ProjectJournalMediaMutationResult<never> {
  const diagnostic = createProjectMediaDiagnostic(stage, error, retryable, cleanupSucceeded);
  return { ok: false, reason, message, retryable, ...(diagnostic ? { diagnostic } : {}) };
}

function errorCode(error: unknown): string | null {
  const code = (error as ErrorLike | null)?.code;
  return typeof code === "string" ? code : null;
}

function errorMessage(error: unknown): string {
  const message = (error as ErrorLike | null)?.message;
  return typeof message === "string" ? message : "";
}

function errorDetails(error: unknown): string {
  const details = (error as ErrorLike | null)?.details;
  return typeof details === "string" ? details : "";
}

function isMediaLimitError(error: unknown): boolean {
  return errorCode(error) === "23514" && /at most 12 media objects/i.test(errorMessage(error));
}

function isMediaOrderConflict(error: unknown): boolean {
  if (errorCode(error) !== "23505") return false;
  return /expedition_project_journal_media_order_unique|journal_entry_id.*sort_order|sort_order/i.test(`${errorMessage(error)} ${errorDetails(error)}`);
}

function isStorageMissingError(error: unknown): boolean {
  const code = errorCode(error);
  const text = `${errorMessage(error)} ${errorDetails(error)}`;
  return code === "404" || code === "not_found" || /not[ -]?found|does not exist|no such object/i.test(text);
}

function relationCount(value: unknown): number {
  if (!Array.isArray(value) || typeof value[0] !== "object" || value[0] === null) return 0;
  const count = (value[0] as { count?: unknown }).count;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

async function nextAvailableSortOrder(
  supabase: SupabaseClient,
  journalEntryId: string,
): Promise<{ value: number | null; error: unknown }> {
  const { data, error } = await supabase
    .from("expedition_project_journal_media")
    .select("sort_order")
    .eq("journal_entry_id", journalEntryId)
    .order("sort_order", { ascending: false })
    .limit(1);
  if (error) return { value: null, error };
  const current = Array.isArray(data) && data.length > 0 && typeof data[0]?.sort_order === "number"
    ? data[0].sort_order
    : -1;
  return { value: current + 1, error: null };
}

async function failureOrRecoverMissingStorageMediaDelete(
  supabase: SupabaseClient,
  projectId: string,
  mediaId: string,
  storageError: unknown,
): Promise<ProjectJournalMediaMutationResult> {
  if (!isStorageMissingError(storageError)) {
    return failure("storage", "media-storage-delete-failed", true, "media-delete-storage", storageError);
  }
  const { error: metadataError } = await supabase.from("expedition_project_journal_media").delete()
    .eq("id", mediaId).eq("project_id", projectId);
  return metadataError
    ? failure("cleanup-required", "media-object-removed-metadata-delete-failed", true, "media-delete-metadata", metadataError, true)
    : { ok: true, data: undefined };
}

export async function uploadProjectJournalMedia(
  supabase: SupabaseClient,
  input: ProjectJournalMediaUploadInput,
  options: { controller?: ProjectMediaUploadController; onProgress?: (percentage: number) => void } = {},
): Promise<ProjectJournalMediaMutationResult<ProjectJournalMedia>> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const user = authData.user;
  if (authError || !user) return failure("auth", "media-auth-required", false, "auth", authError);

  const { data: ownedEntry, error: ownershipError } = await supabase
    .from("expedition_project_journal_entries")
    .select("id, project_id, user_id, expedition_project_journal_media(count)")
    .eq("id", input.journalEntryId)
    .eq("project_id", input.projectId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (ownershipError) return failure("ownership", "media-ownership-check-failed", true, "ownership-query", ownershipError);
  if (!ownedEntry) return failure("ownership", "media-entry-not-owned", false, "ownership-query");
  if (relationCount((ownedEntry as Record<string, unknown>).expedition_project_journal_media) >= PROJECT_JOURNAL_MEDIA_MAX_ITEMS) {
    return failure("limit", "media-limit-reached", false, "metadata-insert");
  }

  if (!input.file.name.trim() || input.file.name.length > 255) {
    return failure("validation", "media-invalid-filename", false, "file-validation");
  }
  const validated = await validateProjectJournalMediaFile(input.file, {
    width: input.width,
    height: input.height,
    durationSeconds: input.durationSeconds,
    sortOrder: input.sortOrder,
  });
  if (!validated.ok) return failure("validation", `media-${validated.reason}`, false, "file-validation", { code: validated.reason });

  const mediaId = input.mediaId ?? crypto.randomUUID();
  if (!isUuid(mediaId)) return failure("validation", "media-invalid-identity", false, "file-validation", { code: "invalid-identity" });
  const storagePath = buildProjectJournalMediaPath({
    userId: user.id,
    projectId: input.projectId,
    journalEntryId: input.journalEntryId,
    mediaId,
    mimeType: validated.data.mimeType,
  });
  if (!storagePath) return failure("validation", "media-invalid-identity", false, "file-validation", { code: "invalid-identity" });

  const { error: uploadError } = await uploadProjectMediaObject(supabase, {
    file: input.file, path: storagePath, contentType: validated.data.mimeType, mediaType: validated.data.mediaType,
  }, options);
  if (uploadError) {
    return failure(errorCode(uploadError) === "409" ? "conflict" : "upload", "media-upload-failed", true, "storage-upload", uploadError);
  }

  let media: ProjectJournalMedia = {
    id: mediaId,
    journalEntryId: input.journalEntryId,
    projectId: input.projectId,
    userId: user.id,
    mediaType: validated.data.mediaType,
    storagePath,
    originalFilename: input.file.name,
    mimeType: validated.data.mimeType,
    sizeBytes: input.file.size,
    width: validated.data.width,
    height: validated.data.height,
    durationSeconds: validated.data.durationSeconds,
    sortOrder: validated.data.sortOrder,
    createdAt: new Date().toISOString(),
  };

  const insertMetadata = (value: ProjectJournalMedia) => supabase.from("expedition_project_journal_media").insert({
    id: value.id,
    journal_entry_id: value.journalEntryId,
    project_id: value.projectId,
    user_id: value.userId,
    media_type: value.mediaType,
    storage_path: value.storagePath,
    original_filename: value.originalFilename,
    mime_type: value.mimeType,
    size_bytes: value.sizeBytes,
    width: value.width,
    height: value.height,
    duration_seconds: value.durationSeconds,
    sort_order: value.sortOrder,
  });

  let { error: metadataError } = await insertMetadata(media);
  if (metadataError && isMediaOrderConflict(metadataError)) {
    const nextOrder = await nextAvailableSortOrder(supabase, input.journalEntryId);
    if (!nextOrder.error && nextOrder.value !== null && nextOrder.value < PROJECT_JOURNAL_MEDIA_MAX_ITEMS) {
      media = { ...media, sortOrder: nextOrder.value };
      ({ error: metadataError } = await insertMetadata(media));
    }
  }
  if (!metadataError) return { ok: true, data: media };

  const { error: cleanupError } = await supabase.storage.from(EXPEDITION_MEDIA_BUCKET).remove([storagePath]);
  if (cleanupError && !isStorageMissingError(cleanupError)) {
    createProjectMediaDiagnostic("metadata-insert", metadataError, true, false);
    return failure("cleanup-required", "media-metadata-and-cleanup-failed", true, "compensation-delete", cleanupError, false);
  }
  if (isMediaLimitError(metadataError)) return failure("limit", "media-limit-reached", false, "metadata-insert", metadataError, true);
  if (errorCode(metadataError) === "23505") return failure("conflict", "media-order-conflict", true, "metadata-insert", metadataError, true);
  return failure("metadata", "media-metadata-create-failed", true, "metadata-insert", metadataError, true);
}

export async function deleteProjectJournalMedia(
  supabase: SupabaseClient,
  projectId: string,
  mediaId: string,
): Promise<ProjectJournalMediaMutationResult> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const user = authData.user;
  if (authError || !user) return failure("auth", "media-auth-required", false, "auth", authError);
  const { data: media, error: loadError } = await supabase
    .from("expedition_project_journal_media")
    .select("id, storage_path")
    .eq("id", mediaId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (loadError) return failure("unknown", "media-load-failed", true, "ownership-query", loadError);
  if (!media || typeof media.storage_path !== "string") return failure("not-found", "media-not-found", false, "ownership-query");

  const { error: storageError } = await supabase.storage.from(EXPEDITION_MEDIA_BUCKET).remove([media.storage_path]);
  if (storageError) return failureOrRecoverMissingStorageMediaDelete(supabase, projectId, mediaId, storageError);
  const { error: metadataError } = await supabase.from("expedition_project_journal_media").delete()
    .eq("id", mediaId).eq("project_id", projectId);
  return metadataError
    ? failure("cleanup-required", "media-object-removed-metadata-delete-failed", true, "media-delete-metadata", metadataError, true)
    : { ok: true, data: undefined };
}

export async function deleteProjectJournalEntryWithMedia(
  supabase: SupabaseClient,
  projectId: string,
  journalEntryId: string,
): Promise<ProjectJournalMediaMutationResult> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const user = authData.user;
  if (authError || !user) return failure("auth", "media-auth-required", false, "auth", authError);
  const { data: entry, error: loadError } = await supabase
    .from("expedition_project_journal_entries")
    .select("id, expedition_project_journal_media(storage_path)")
    .eq("id", journalEntryId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (loadError) return failure("unknown", "journal-media-load-failed", true, "journal-media-cleanup", loadError);
  if (!entry) return failure("not-found", "journal-entry-not-found", false, "journal-media-cleanup");

  const paths = Array.isArray(entry.expedition_project_journal_media)
    ? entry.expedition_project_journal_media.flatMap((row) =>
      typeof row === "object" && row !== null && typeof row.storage_path === "string" ? [row.storage_path] : [])
    : [];
  if (paths.length > 0) {
    const { error: storageError } = await supabase.storage.from(EXPEDITION_MEDIA_BUCKET).remove(paths);
    if (storageError && !isStorageMissingError(storageError)) {
      return failure("storage", "journal-media-storage-delete-failed", true, "journal-media-cleanup", storageError, false);
    }
  }

  const { error: deleteError } = await supabase.from("expedition_project_journal_entries").delete()
    .eq("id", journalEntryId).eq("project_id", projectId);
  return deleteError
    ? failure(paths.length > 0 ? "cleanup-required" : "unknown", paths.length > 0
      ? "journal-media-removed-entry-delete-failed"
      : "journal-entry-delete-failed", true, "journal-media-cleanup", deleteError, paths.length > 0)
    : { ok: true, data: undefined };
}
