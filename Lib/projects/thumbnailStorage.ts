import { randomUUID } from "node:crypto";
import { isUuid } from "./mediaPaths.ts";

export const EXPEDITION_THUMBNAIL_BUCKET = "expedition-media-thumbnails";

export type ThumbnailStorageCredentials = { url: string; secret: string };
type PhotoObject = { bucket: string; path: string; version: string; size: number; mime: string };

export class ThumbnailStorageError extends Error {
  readonly kind: "source_changed" | "storage";

  constructor(kind: "source_changed" | "storage") {
    super("Thumbnail Storage identity could not be verified");
    this.kind = kind;
  }
}

async function readBoundedBytes(stream: ReadableStream<Uint8Array>, size: number) {
  const reader = stream.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return bytes.subarray(0, offset);
      if (chunk.value.byteLength > size - offset) {
        await reader.cancel();
        return null;
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function readExactMediaBytes(stream: ReadableStream<Uint8Array>, size: number) {
  const bytes = await readBoundedBytes(stream, size);
  return bytes?.length === size ? bytes : null;
}

async function isMissingStorageVersion(response: Response) {
  if (response.status !== 400 || !response.body
    || response.headers.get("Content-Type")?.split(";")[0] !== "application/json") {
    await response.body?.cancel();
    return response.status === 404;
  }
  // Hosted Storage can wrap NoSuchKey in HTTP 400 with an embedded 404.
  const bytes = await readBoundedBytes(response.body, 1024);
  if (!bytes) return false;
  try {
    const error = JSON.parse(new TextDecoder().decode(bytes));
    return error?.code === "NoSuchKey" && error.error === "not_found" && error.statusCode === "404";
  } catch {
    return false;
  }
}

// An exact-version URL selects versioned bytes on the Storage renderer. A
// random absent version catches gateways that silently ignore versionId.
export async function readVersionedPhoto(
  credentials: ThumbnailStorageCredentials, object: PhotoObject, signal: AbortSignal, request = fetch,
) {
  if (!isUuid(object.version) || !Number.isSafeInteger(object.size) || object.size < 1
    || object.size > 10 * 1024 * 1024 || !/^[a-z-]+$/.test(object.bucket)
    || object.path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ThumbnailStorageError("source_changed");
  }
  const path = object.path.split("/").map(encodeURIComponent).join("/");
  const endpoint = new URL(`/storage/v1/object/authenticated/${object.bucket}/${path}`, credentials.url);
  const headers: Record<string, string> = { apikey: credentials.secret, "Cache-Control": "no-cache" };
  if (!credentials.secret.startsWith("sb_secret_")) headers.Authorization = `Bearer ${credentials.secret}`;
  const init = { signal, headers, cache: "no-store", redirect: "error" } as const;

  endpoint.searchParams.set("versionId", randomUUID());
  const absent = await request(endpoint.toString(), init);
  if (!await isMissingStorageVersion(absent)) throw new ThumbnailStorageError("storage");

  endpoint.searchParams.set("versionId", object.version);
  const response = await request(endpoint.toString(), init);
  if (response.status !== 200) {
    const missing = await isMissingStorageVersion(response);
    throw new ThumbnailStorageError(missing ? "source_changed" : "storage");
  }
  const encodedLength = response.headers.get("Content-Length");
  if (!response.body || response.headers.get("Content-Type")?.split(";")[0] !== object.mime
    || (encodedLength !== null && Number(encodedLength) !== object.size)) {
    await response.body?.cancel();
    throw new ThumbnailStorageError("source_changed");
  }
  const bytes = await readExactMediaBytes(response.body, object.size);
  if (!bytes) throw new ThumbnailStorageError("source_changed");
  return bytes;
}
