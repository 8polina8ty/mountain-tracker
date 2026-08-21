import { resolvePublicPhoto, type PublicPhotoVariant } from "@/Lib/projects/publicReport";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string; handle: string }> }) {
  const started = performance.now();
  const { slug, handle } = await params;
  const requestedVariant = new URL(request.url).searchParams.get("variant") ?? "original";
  if (requestedVariant !== "thumb" && requestedVariant !== "original") return new Response(null, { status: 400 });
  const media = await resolvePublicPhoto(slug, handle, requestedVariant as PublicPhotoVariant);
  if (!media) return new Response(null, { status: 404 });
  const responseStarted = performance.now();
  const response = new Response(media.blob.stream(), { headers: { "Content-Type": media.mimeType, "Content-Length": String(media.blob.size), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" } });
  if (process.env.NODE_ENV === "development") console.info("[PublicMedia DEV]", { totalMs: Math.round(performance.now() - started), shareResolveMs: Math.round(media.timing.shareResolveMs), handleValidationMs: Math.round(media.timing.handleValidationMs), mediaLookupMs: Math.round(media.timing.mediaLookupMs), storageDownloadMs: Math.round(media.timing.storageDownloadMs), responsePreparationMs: Math.round(performance.now() - responseStarted), responseBytes: media.blob.size, mimeCategory: "photo", cacheDecision: "private-no-store", requestOutcome: "success" });
  return response;
}
