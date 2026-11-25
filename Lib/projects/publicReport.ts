import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { StorageApiError } from "@supabase/supabase-js";
import { createAdminClient, getSupabaseAdminCredentials } from "@/Lib/supabase/admin";
import { buildProjectCompletionSummary } from "./completion.ts";
import { isUuid } from "./mediaPaths.ts";
import { getUserProject, listProjectDayTrackEvidence } from "./queries.ts";
import { EXPEDITION_THUMBNAIL_BUCKET, readVersionedPhoto } from "./thumbnailStorage.ts";
import type { ExpeditionProject, ProjectMountainEvidenceState } from "./types.ts";

type PublicSummary = { totalDays: number; daysWithGpsEvidence: number; uniqueTrackCount: number; totalDistanceM: number; totalElevationGainM: number; totalDurationSeconds: number; plannedMountainCount: number; verifiedMountainCount: number; likelyMountainCount: number; journalEntryCount: number; photoCount: number; videoCount: number };
export type PublicExpeditionReport = { name: string; status: "completed" | "archived"; startDate: string | null; endDate: string | null; summary: PublicSummary; mountains: Array<{ name: string; state: ProjectMountainEvidenceState }>; days: Array<{ number: number; date: string | null; title: string | null; plannedMountains: string[]; tracks: Array<{ title: string | null; distanceM: number | null; durationSeconds: number | null; elevationGainM: number | null; verification: string }>; journal: Array<{ date: string; title: string | null; body: string; media: Array<{ handle: string; type: "photo" | "video"; durationSeconds: number | null }> }> }> };
export type PublicPhotoVariant = "thumb" | "original";
type PublicMediaTiming = { shareResolveMs: number; handleValidationMs: number; mediaLookupMs: number; storageDownloadMs: number };

const PUBLIC_SLUG_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const PUBLIC_MEDIA_HANDLE_PATTERN = /^[A-Za-z0-9_-]{60}$/;
const PUBLIC_MEDIA_HANDLE_VERSION = 2;
const PUBLIC_MEDIA_HANDLE_IV_BYTES = 12;
const PUBLIC_MEDIA_HANDLE_PLAINTEXT_BYTES = 16;
const PUBLIC_MEDIA_HANDLE_TAG_BYTES = 16;
const MAX_THUMB_FALLBACK_BYTES = 512 * 1024;
const TRANSFORM_UNAVAILABLE = "feature not enabled for this tenant";

function matchesPhotoSignature(bytes: Uint8Array, mimeType: string) {
  const header = Buffer.from(bytes.subarray(0, 12));
  if (mimeType === "image/jpeg") return header.subarray(0, 3).toString("hex") === "ffd8ff";
  if (mimeType === "image/png") return header.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  return mimeType === "image/webp"
    && header.subarray(0, 4).toString("ascii") === "RIFF"
    && header.subarray(8, 12).toString("ascii") === "WEBP";
}

async function readThumbnailFallback(stream: ReadableStream<Uint8Array>, size: number, mimeType: string) {
  const reader = stream.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > size - offset) {
        await reader.cancel();
        return null;
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
    return offset === size && matchesPhotoSignature(bytes, mimeType)
      ? new Blob([bytes], { type: mimeType })
      : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function handleSecret() {
  const value = process.env.PUBLIC_EXPEDITION_MEDIA_SECRET;
  if (!value) throw new Error("Public expedition media signing is not configured.");
  return value;
}

function mediaHandleKey() {
  return createHash("sha256").update(`mountain-tracker-public-media-v${PUBLIC_MEDIA_HANDLE_VERSION}:${handleSecret()}`).digest();
}

function uuidBytes(mediaId: string) {
  if (!isUuid(mediaId)) return null;
  const bytes = Buffer.from(mediaId.replaceAll("-", ""), "hex");
  return bytes.length === PUBLIC_MEDIA_HANDLE_PLAINTEXT_BYTES ? bytes : null;
}

function uuidFromBytes(bytes: Buffer) {
  if (bytes.length !== PUBLIC_MEDIA_HANDLE_PLAINTEXT_BYTES) return null;
  const hex = bytes.toString("hex");
  const mediaId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return isUuid(mediaId) ? mediaId : null;
}

function mediaHandle(slug: string, mediaId: string) {
  const plaintext = uuidBytes(mediaId);
  if (!plaintext || !PUBLIC_SLUG_PATTERN.test(slug)) throw new Error("Invalid public media handle input.");
  const iv = randomBytes(PUBLIC_MEDIA_HANDLE_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", mediaHandleKey(), iv);
  cipher.setAAD(Buffer.from(`v${PUBLIC_MEDIA_HANDLE_VERSION}:${slug}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([PUBLIC_MEDIA_HANDLE_VERSION]), iv, encrypted, tag]).toString("base64url");
}

function mediaIdFromHandle(slug: string, handle: string) {
  if (!PUBLIC_SLUG_PATTERN.test(slug) || !PUBLIC_MEDIA_HANDLE_PATTERN.test(handle)) return null;
  try {
    const token = Buffer.from(handle, "base64url");
    const expectedLength = 1 + PUBLIC_MEDIA_HANDLE_IV_BYTES + PUBLIC_MEDIA_HANDLE_PLAINTEXT_BYTES + PUBLIC_MEDIA_HANDLE_TAG_BYTES;
    if (token.length !== expectedLength || token[0] !== PUBLIC_MEDIA_HANDLE_VERSION) return null;
    const ivStart = 1;
    const encryptedStart = ivStart + PUBLIC_MEDIA_HANDLE_IV_BYTES;
    const tagStart = encryptedStart + PUBLIC_MEDIA_HANDLE_PLAINTEXT_BYTES;
    const iv = token.subarray(ivStart, encryptedStart);
    const encrypted = token.subarray(encryptedStart, tagStart);
    const tag = token.subarray(tagStart);
    const decipher = createDecipheriv("aes-256-gcm", mediaHandleKey(), iv);
    decipher.setAAD(Buffer.from(`v${PUBLIC_MEDIA_HANDLE_VERSION}:${slug}`, "utf8"));
    decipher.setAuthTag(tag);
    return uuidFromBytes(Buffer.concat([decipher.update(encrypted), decipher.final()]));
  } catch {
    return null;
  }
}

async function resolveShare(slug: string) {
  if (!PUBLIC_SLUG_PATTERN.test(slug)) return null;
  const admin = createAdminClient();
  const [{ data, error }, { data: publicHeader, error: publicError }] = await Promise.all([
    admin.rpc("resolve_public_expedition_share", { requested_slug: slug }),
    admin.rpc("get_public_expedition_report", { requested_slug: slug }),
  ]);
  const row = !error && Array.isArray(data) ? data[0] as { project_id?: string; owner_id?: string } | undefined : undefined;
  const header = !publicError && publicHeader && typeof publicHeader === "object" && !Array.isArray(publicHeader)
    ? publicHeader as { name?: unknown; status?: unknown; startDate?: unknown; endDate?: unknown }
    : null;
  return row?.project_id && row.owner_id && typeof header?.name === "string" && (header.status === "completed" || header.status === "archived")
    ? {
        admin,
        projectId: row.project_id,
        ownerId: row.owner_id,
        publicHeader: {
          name: header.name,
          status: header.status as "completed" | "archived",
          startDate: typeof header.startDate === "string" ? header.startDate : null,
          endDate: typeof header.endDate === "string" ? header.endDate : null,
        },
      }
    : null;
}

async function resolveMediaShare(slug: string) {
  if (!PUBLIC_SLUG_PATTERN.test(slug)) return null;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("resolve_public_expedition_share", { requested_slug: slug });
  const row = !error && Array.isArray(data) ? data[0] as { project_id?: string } | undefined : undefined;
  return row?.project_id ? { admin, projectId: row.project_id } : null;
}

export async function loadPublicExpeditionReport(slug: string): Promise<PublicExpeditionReport | null> {
  const resolved = await resolveShare(slug);
  if (!resolved) return null;
  const [project, evidence] = await Promise.all([
    getUserProject(resolved.admin, resolved.ownerId, resolved.projectId),
    listProjectDayTrackEvidence(resolved.admin, resolved.ownerId, resolved.projectId),
  ]);
  if (!project || (project.status !== "completed" && project.status !== "archived")) return null;

  const projectWithEvidence: ExpeditionProject = {
    ...project,
    days: project.days.map((day) => ({
      ...day,
      trackEvidence: evidence.filter((track) => track.projectDayId === day.id),
    })),
  };
  const full = buildProjectCompletionSummary(projectWithEvidence);
  const summary: PublicSummary = {
    totalDays: full.totalDays,
    daysWithGpsEvidence: full.daysWithGpsEvidence,
    uniqueTrackCount: full.uniqueTrackCount,
    totalDistanceM: full.totalDistanceM,
    totalElevationGainM: full.totalElevationGainM,
    totalDurationSeconds: full.totalDurationSeconds,
    plannedMountainCount: full.plannedMountainCount,
    verifiedMountainCount: full.verifiedMountainCount,
    likelyMountainCount: full.likelyMountainCount,
    journalEntryCount: full.journalEntryCount,
    photoCount: full.photoCount,
    videoCount: full.videoCount,
  };
  return {
    name: resolved.publicHeader.name,
    status: resolved.publicHeader.status,
    startDate: resolved.publicHeader.startDate,
    endDate: resolved.publicHeader.endDate,
    summary,
    mountains: projectWithEvidence.mountains.map((mountain) => ({
      name: mountain.nameDe ?? mountain.name ?? "Mountain",
      state: full.mountainEvidence.find((item) => item.mountainId === mountain.id)?.state ?? "no-evidence",
    })),
    days: projectWithEvidence.days.map((day) => ({
      number: day.dayNumber,
      date: day.date,
      title: day.title,
      plannedMountains: day.mountains.map((mountain) => mountain.nameDe ?? mountain.name ?? "Mountain"),
      tracks: day.trackEvidence.map((track) => ({
        title: track.title,
        distanceM: track.distanceM,
        durationSeconds: track.durationSeconds,
        elevationGainM: track.elevationGainM,
        verification: track.gpsVerified ? "verified" : track.detectedMountainId === null ? "not-detected" : "likely",
      })),
      journal: projectWithEvidence.journalEntries
        .filter((entry) => entry.projectDayId === day.id)
        .map((entry) => ({
          date: entry.entryDate,
          title: entry.title,
          body: entry.body,
          media: entry.media.map((media) => ({
            handle: mediaHandle(slug, media.id),
            type: media.mediaType,
            durationSeconds: media.durationSeconds,
          })),
        })),
    })),
  };
}

async function resolvePublicDerivative(
  slug: string, mediaId: string, resolved: NonNullable<Awaited<ReturnType<typeof resolveMediaShare>>>, timing: PublicMediaTiming,
) {
  const { admin, projectId } = resolved;
  const locate = async () => {
    const { data, error } = await admin.rpc("expedition_thumbnail_lookup", { p_project_id: projectId, p_media_id: mediaId });
    return !error && Array.isArray(data) && data.length === 1 ? data[0] as {
      object_key: string; object_id: string; object_version: string; size_bytes: number;
    } : null;
  };
  const lookupStarted = performance.now();
  const derivative = await locate();
  timing.mediaLookupMs += performance.now() - lookupStarted;
  const mimeType = "image/webp";
  if (!derivative || !isUuid(derivative.object_id) || typeof derivative.object_key !== "string"
    || !Number.isInteger(derivative.size_bytes) || derivative.size_bytes < 1 || derivative.size_bytes > 65_536) return null;
  const [keyMedia, version, file, extra] = derivative.object_key.split("/");
  if (keyMedia !== mediaId || (version !== "v1" && version !== "v2")
    || !file?.endsWith(".webp") || !isUuid(file.slice(0, -5)) || extra !== undefined) return null;
  try {
    const downloadStarted = performance.now();
    const bytes = await readVersionedPhoto(getSupabaseAdminCredentials(), {
      bucket: EXPEDITION_THUMBNAIL_BUCKET, path: derivative.object_key, version: derivative.object_version,
      size: derivative.size_bytes, mime: mimeType,
    }, AbortSignal.timeout(5000));
    timing.storageDownloadMs += performance.now() - downloadStarted;
    if (!matchesPhotoSignature(bytes, mimeType)) return null;

    const recheckStarted = performance.now();
    const share = await resolveMediaShare(slug);
    timing.shareResolveMs += performance.now() - recheckStarted;
    if (share?.projectId !== projectId) return null;
    const recheckLookupStarted = performance.now();
    const current = await locate();
    timing.mediaLookupMs += performance.now() - recheckLookupStarted;
    if (current?.object_id !== derivative.object_id || current.object_version !== derivative.object_version
      || current.object_key !== derivative.object_key || current.size_bytes !== derivative.size_bytes) return null;
    return { blob: new Blob([bytes], { type: mimeType }), mimeType, timing };
  } catch {
    return null;
  }
}

export async function resolvePublicPhoto(slug: string, handle: string, variant: PublicPhotoVariant) {
  const timing: PublicMediaTiming = { shareResolveMs: 0, handleValidationMs: 0, mediaLookupMs: 0, storageDownloadMs: 0 };

  const validationStarted = performance.now();
  const mediaId = mediaIdFromHandle(slug, handle);
  timing.handleValidationMs = performance.now() - validationStarted;
  if (!mediaId) return null;

  const shareStarted = performance.now();
  const resolved = await resolveMediaShare(slug);
  timing.shareResolveMs = performance.now() - shareStarted;
  if (!resolved) return null;
  if (variant === "thumb" && process.env.EXPEDITION_THUMBNAIL_DELIVERY === "1") {
    return resolvePublicDerivative(slug, mediaId, resolved, timing);
  }

  const lookupStarted = performance.now();
  const { data: media, error: mediaError } = await resolved.admin
    .from("expedition_project_journal_media")
    .select("storage_path,mime_type,size_bytes")
    .eq("id", mediaId)
    .eq("project_id", resolved.projectId)
    .eq("media_type", "photo")
    .maybeSingle();
  timing.mediaLookupMs = performance.now() - lookupStarted;
  const size = Number(media?.size_bytes);
  const originalMime = String(media?.mime_type);
  if (mediaError || !media || !["image/jpeg", "image/png", "image/webp"].includes(originalMime)
    || !Number.isSafeInteger(size) || size < 1 || size > 10 * 1024 * 1024) return null;

  const downloadStarted = performance.now();
  const storage = resolved.admin.storage.from("expedition-media");
  const path = String(media.storage_path);
  if (variant === "original") {
    try {
      const { data: stream, error } = await storage
        .download(path, {}, { cache: "no-store", signal: AbortSignal.timeout(5000) })
        .asStream();
      if (error || !stream) return null;
      const blob = await readThumbnailFallback(stream, size, originalMime);
      timing.storageDownloadMs = performance.now() - downloadStarted;
      return blob ? { blob, mimeType: originalMime, timing } : null;
    } catch {
      return null;
    }
  }

  const options = { transform: { width: 256, height: 256, resize: "contain" as const, quality: 75, format: "origin" as const } };
  const { data: blob, error } = await storage.download(path, options, { cache: "no-store" });
  timing.storageDownloadMs = performance.now() - downloadStarted;
  const mimeType = blob?.type || String(media.mime_type);
  if (!error) {
    return blob && ["image/jpeg", "image/png", "image/webp"].includes(mimeType)
      ? { blob, mimeType, timing }
      : null;
  }

  if (!(error instanceof StorageApiError) || error.status !== 403
    || error.statusCode !== "403" || error.message !== TRANSFORM_UNAVAILABLE
    || !Number.isSafeInteger(size) || size < 1 || size > MAX_THUMB_FALLBACK_BYTES) return null;

  const recheckStarted = performance.now();
  const recheckedShare = await resolveMediaShare(slug);
  timing.shareResolveMs += performance.now() - recheckStarted;
  if (recheckedShare?.projectId !== resolved.projectId) return null;

  const fallbackStarted = performance.now();
  try {
    const { data: stream, error: fallbackError } = await storage
      .download(path, {}, { cache: "no-store", signal: AbortSignal.timeout(5000) })
      .asStream();
    if (fallbackError || !stream) return null;
    const original = await readThumbnailFallback(stream, size, mimeType);
    timing.storageDownloadMs += performance.now() - fallbackStarted;
    return original ? { blob: original, mimeType, timing } : null;
  } catch {
    return null;
  }
}
