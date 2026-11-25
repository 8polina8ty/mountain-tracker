import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminCredentials } from "../supabase/admin.ts";
import { canonicalExtensionForMime, EXPEDITION_MEDIA_BUCKET, isUuid } from "./mediaPaths.ts";
import { isThumbnailPhotoMime, processExpeditionThumbnail, ThumbnailDecodeError } from "./thumbnailProcessor.ts";
import { EXPEDITION_THUMBNAIL_BUCKET, readVersionedPhoto, ThumbnailStorageError } from "./thumbnailStorage.ts";

type GenerationJob = {
  media_id: string;
  project_id: string;
  attempt_id: string;
  processing_version: number;
  source_path: string;
  source_mime: string;
  source_size: number;
  source_object_id: string;
  source_version: string;
  derivative_key: string;
};
type CleanupJob = { attempt_id: string; object_key: string; lease_token: string };

function immutableKey(attemptId: string, path: string) {
  const [mediaId, version, filename, extra] = path.split("/");
  return isUuid(mediaId ?? "") && (version === "v1" || version === "v2")
    && filename === `${attemptId}.webp` && !extra && isUuid(attemptId);
}

async function workerRpc<T>(db: SupabaseClient, name: string, args?: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error("Thumbnail worker database request failed");
  return data as T;
}

async function cleanAttempt(db: SupabaseClient, job: CleanupJob) {
  if (!immutableKey(job.attempt_id, job.object_key) || !isUuid(job.lease_token)) {
    throw new Error("Invalid cleanup lease");
  }
  const fence = { p_attempt_id: job.attempt_id, p_lease_token: job.lease_token };
  if (await workerRpc<boolean>(db, "expedition_thumbnail_worker_may_remove", fence)) {
    // A lost Storage response can still be acknowledged via the catalog fence.
    await db.storage.from(EXPEDITION_THUMBNAIL_BUCKET).remove([job.object_key]);
  }
  return workerRpc<boolean>(db, "expedition_thumbnail_finish_cleanup", fence);
}

async function generateThumbnail(
  db: SupabaseClient, credentials: ReturnType<typeof getSupabaseAdminCredentials>, job: GenerationJob, signal: AbortSignal,
) {
  const fence = { p_media_id: job.media_id, p_attempt_id: job.attempt_id };
  try {
    const segments = job.source_path.split("/");
    if (!isUuid(job.media_id) || !isUuid(job.project_id) || !isUuid(job.source_object_id)
      || !isThumbnailPhotoMime(job.source_mime)
      || segments.length !== 5 || !isUuid(segments[0]) || !isUuid(segments[2])
      || segments[1] !== job.project_id || segments[3] !== job.media_id
      || segments[4] !== `original.${canonicalExtensionForMime(job.source_mime)}`
      || job.derivative_key !== `${job.media_id}/v${job.processing_version}/${job.attempt_id}.webp`
      || !immutableKey(job.attempt_id, job.derivative_key)) throw new ThumbnailDecodeError("invalid_source");
    if (!await workerRpc<boolean>(db, "expedition_thumbnail_may_upload", fence)) return { outcome: "fenced" };

    const source = await readVersionedPhoto(credentials, {
      bucket: EXPEDITION_MEDIA_BUCKET, path: job.source_path, size: Number(job.source_size),
      version: job.source_version, mime: job.source_mime,
    }, signal);
    const processed = await processExpeditionThumbnail(Buffer.from(source.buffer), job.source_mime, signal);

    if (!await workerRpc<boolean>(db, "expedition_thumbnail_may_upload", fence)) {
      await workerRpc(db, "expedition_thumbnail_fail", { ...fence, p_error: "source_changed", p_retry: true });
      return { outcome: "fenced" };
    }
    const storage = db.storage.from(EXPEDITION_THUMBNAIL_BUCKET);
    const { data: upload, error } = await storage.upload(job.derivative_key, processed.bytes, {
      contentType: "image/webp", cacheControl: "0", upsert: false,
    });
    if (error || !upload?.id || !isUuid(upload.id)) throw new ThumbnailStorageError("storage");
    const { data: info, error: infoError } = await storage.info(job.derivative_key);
    if (infoError || info?.id !== upload.id || !info.version) throw new ThumbnailStorageError("storage");

    const publishedBytes = await readVersionedPhoto(credentials, {
      bucket: EXPEDITION_THUMBNAIL_BUCKET, path: job.derivative_key, version: info.version,
      size: processed.bytes.length, mime: "image/webp",
    }, signal);
    if (!processed.bytes.equals(Buffer.from(publishedBytes.buffer))) throw new ThumbnailStorageError("storage");
    const completed = await workerRpc<boolean>(db, "expedition_thumbnail_complete", {
      ...fence, p_source_id: job.source_object_id, p_source_version: job.source_version,
      p_derivative_id: upload.id, p_derivative_version: info.version,
      p_width: processed.width, p_height: processed.height, p_size_bytes: processed.bytes.length,
    });
    if (!completed) {
      await workerRpc(db, "expedition_thumbnail_fail", { ...fence, p_error: "source_changed", p_retry: true });
      return { outcome: "fenced" };
    }
    return { outcome: "ready", size: processed.bytes.length, decodeMs: processed.elapsedMs, decoderRss: processed.peakRss };
  } catch (error) {
    const reason = error instanceof ThumbnailDecodeError || error instanceof ThumbnailStorageError ? error.kind : "storage";
    if (!signal.aborted) {
      await workerRpc(db, "expedition_thumbnail_fail", { ...fence, p_error: reason, p_retry: reason !== "invalid_source" });
    }
    return { outcome: reason };
  }
}

export async function runExpeditionThumbnailWorker(signal: AbortSignal) {
  const credentials = getSupabaseAdminCredentials();
  const db = createClient(credentials.url, credentials.secret, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal, redirect: "error", cache: "no-store" }) },
  });
  const token = await workerRpc<string | null>(db, "expedition_thumbnail_worker_acquire");
  if (!token) return { status: "busy" };
  try {
    let removed = 0;
    const cleanup = await workerRpc<CleanupJob[]>(db, "expedition_thumbnail_claim_cleanup", { p_limit: 2, p_lease_seconds: 90 });
    for (const job of cleanup) {
      signal.throwIfAborted();
      if (await cleanAttempt(db, job)) removed += 1;
    }
    const [job] = await workerRpc<GenerationJob[]>(db, "expedition_thumbnail_worker_claim", {
      p_token: token, p_supported_version: 1,
    });
    const generation = job ? await generateThumbnail(db, credentials, job, signal) : { outcome: "idle" };
    signal.throwIfAborted();
    return { status: "completed", cleanupAcknowledged: removed, generation };
  } finally {
    // An interrupted request leaves the singleton lease to expire.
    if (!signal.aborted) await workerRpc(db, "expedition_thumbnail_worker_release", { p_token: token });
  }
}
