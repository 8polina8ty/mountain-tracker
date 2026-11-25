import { createHash, timingSafeEqual } from "node:crypto";
import { runExpeditionThumbnailWorker } from "@/Lib/projects/thumbnailJobs";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const secret = process.env.EXPEDITION_THUMBNAIL_WORKER_SECRET;
  const authorization = request.headers.get("Authorization") ?? "";
  const headers = { "Cache-Control": "private, no-store" };
  if (process.env.EXPEDITION_THUMBNAIL_WORKER_ENABLED !== "1" || !secret || secret.length < 32) {
    return new Response(null, { status: 404, headers });
  }
  if (!timingSafeEqual(createHash("sha256").update(authorization).digest(),
    createHash("sha256").update(`Bearer ${secret}`).digest())) {
    return new Response(null, { status: 401, headers });
  }
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]);
    const result = await runExpeditionThumbnailWorker(signal);
    console.info("[Expedition thumbnails]", result);
    return Response.json(result, { headers });
  } catch {
    console.warn("[Expedition thumbnails]", { status: "failed" });
    return Response.json({ status: "failed" }, { status: 503, headers });
  }
}
