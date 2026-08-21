import type { SupabaseClient } from "@supabase/supabase-js";
import { Upload } from "tus-js-client";

import { EXPEDITION_MEDIA_BUCKET } from "./mediaPaths.ts";

export const PROJECT_VIDEO_TUS_THRESHOLD_BYTES = 6 * 1024 * 1024;
export const PROJECT_VIDEO_TUS_CHUNK_BYTES = 6 * 1024 * 1024;

export type ProjectMediaUploadTransport = "standard" | "tus";

export function selectProjectMediaUploadTransport(mediaType: "photo" | "video", sizeBytes: number): ProjectMediaUploadTransport {
  return mediaType === "video" && sizeBytes > PROJECT_VIDEO_TUS_THRESHOLD_BYTES ? "tus" : "standard";
}

export class ProjectMediaUploadController {
  private upload: Upload | null = null;
  private rejectUpload: ((error: Error) => void) | null = null;
  bind(upload: Upload, rejectUpload: (error: Error) => void) { this.upload = upload; this.rejectUpload = rejectUpload; }
  async pause() { await this.upload?.abort(false); }
  resume() { this.upload?.start(); }
  async cancel() {
    await this.upload?.abort(true);
    this.rejectUpload?.(new Error("upload-cancelled"));
  }
}

function resumableEndpoint(supabaseUrl: string): string {
  const url = new URL(supabaseUrl);
  if (url.hostname.endsWith(".supabase.co") && !url.hostname.endsWith(".storage.supabase.co")) {
    url.hostname = url.hostname.replace(/\.supabase\.co$/, ".storage.supabase.co");
  }
  return `${url.origin}/storage/v1/upload/resumable`;
}

async function resumeFingerprint(path: string, file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `project-media-${hash}-${file.size}-${file.lastModified}`;
}

export async function uploadProjectMediaObject(
  supabase: SupabaseClient,
  input: { file: File; path: string; contentType: string; mediaType: "photo" | "video" },
  options: { controller?: ProjectMediaUploadController; onProgress?: (percentage: number) => void } = {},
): Promise<{ error: unknown }> {
  if (selectProjectMediaUploadTransport(input.mediaType, input.file.size) === "standard") {
    options.onProgress?.(0);
    const { error } = await supabase.storage.from(EXPEDITION_MEDIA_BUCKET).upload(input.path, input.file, {
      cacheControl: "3600", contentType: input.contentType, upsert: false,
    });
    if (!error) options.onProgress?.(100);
    return { error };
  }

  const { data, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !data.session) return { error: sessionError ?? new Error("upload-session-required") };
  const supabaseUrl = (supabase as SupabaseClient & { supabaseUrl: string }).supabaseUrl;
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (error: unknown) => { if (!settled) { settled = true; resolve({ error }); } };
    const upload = new Upload(input.file, {
      endpoint: resumableEndpoint(supabaseUrl),
      retryDelays: [0, 3_000, 5_000, 10_000, 20_000],
      headers: { authorization: `Bearer ${data.session.access_token}` },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: PROJECT_VIDEO_TUS_CHUNK_BYTES,
      metadata: { bucketName: EXPEDITION_MEDIA_BUCKET, objectName: input.path, contentType: input.contentType, cacheControl: "3600" },
      fingerprint: (file) => resumeFingerprint(input.path, file as File),
      onProgress: (sent, total) => options.onProgress?.(total > 0 ? Math.min(100, Math.max(0, sent / total * 100)) : 0),
      onError: finish,
      onSuccess: () => finish(null),
    });
    options.controller?.bind(upload, finish);
    void upload.findPreviousUploads().then((previous) => {
      if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    }).catch(finish);
  });
}
