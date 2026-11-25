import { spawn } from "node:child_process";
import { join } from "node:path";
import { PROJECT_JOURNAL_PHOTO_MAX_BYTES } from "./mediaValidation.ts";

export const THUMBNAIL_MAX_BYTES = 65_536;
export type ThumbnailPhotoMime = "image/jpeg" | "image/png" | "image/webp";

export function isThumbnailPhotoMime(value: string): value is ThumbnailPhotoMime {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}

type ThumbnailResult = {
  bytes: Buffer;
  width: number;
  height: number;
  elapsedMs: number;
  peakRss: number;
};

export class ThumbnailDecodeError extends Error {
  readonly kind: "invalid_source" | "processing";

  constructor(kind: "invalid_source" | "processing") {
    super("Thumbnail decoder did not produce a valid image");
    this.kind = kind;
  }
}

// Native decoding runs in a bounded child with no service credentials.
export async function processExpeditionThumbnail(
  input: Buffer, mime: ThumbnailPhotoMime, signal?: AbortSignal,
): Promise<ThumbnailResult> {
  if (input.length < 1 || input.length > PROJECT_JOURNAL_PHOTO_MAX_BYTES || !isThumbnailPhotoMime(mime)) {
    throw new ThumbnailDecodeError("invalid_source");
  }
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--max-old-space-size=48",
      join(process.cwd(), "Lib", "projects", "thumbnailDecodeWorker.cjs"), mime, String(input.length),
    ], {
      stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
      env: { NODE_ENV: "production", SystemRoot: process.env.SystemRoot, VIPS_CONCURRENCY: "1", MALLOC_ARENA_MAX: "2" },
    });
    const chunks: Buffer[] = [];
    let outputSize = 0;
    let interrupted = false;
    const stop = () => {
      interrupted = true;
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(stop, 8_000);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > 90_000) stop();
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => { /* The child may reject invalid input early. */ });
    child.on("error", () => { interrupted = true; });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
      if (interrupted || code === 3 || code === 4 || code === null) return reject(new ThumbnailDecodeError("processing"));
      if (code !== 0 || !outputSize) return reject(new ThumbnailDecodeError("invalid_source"));
      try {
        const { webp, width, height, elapsedMs, peakRss } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const bytes = Buffer.from(webp, "base64");
        if (bytes.length < 12 || bytes.length > THUMBNAIL_MAX_BYTES
          || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP"
          || ![width, height].every((value) => Number.isInteger(value) && value >= 1 && value <= 256)
          || !Number.isInteger(elapsedMs) || elapsedMs < 0 || !Number.isInteger(peakRss) || peakRss < 1) {
          throw new ThumbnailDecodeError("processing");
        }
        resolve({ bytes, width, height, elapsedMs, peakRss });
      } catch {
        reject(new ThumbnailDecodeError("processing"));
      }
    });
    child.stdin.end(input);
  });
}
