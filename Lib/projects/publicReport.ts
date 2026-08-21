import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/Lib/supabase/admin";
import { buildProjectCompletionSummary } from "./completion.ts";
import { getUserProject, listProjectDayTrackEvidence } from "./queries.ts";
import type { ProjectMountainEvidenceState } from "./types.ts";

type PublicSummary = { totalDays: number; daysWithGpsEvidence: number; uniqueTrackCount: number; totalDistanceM: number; totalElevationGainM: number; totalDurationSeconds: number; plannedMountainCount: number; verifiedMountainCount: number; likelyMountainCount: number; journalEntryCount: number; photoCount: number; videoCount: number };
export type PublicExpeditionReport = { name: string; status: "completed" | "archived"; startDate: string | null; endDate: string | null; summary: PublicSummary; mountains: Array<{ name: string; state: ProjectMountainEvidenceState }>; days: Array<{ number: number; date: string | null; title: string | null; plannedMountains: string[]; tracks: Array<{ title: string | null; distanceM: number | null; durationSeconds: number | null; elevationGainM: number | null; verification: string }>; journal: Array<{ date: string; title: string | null; body: string; media: Array<{ handle: string; type: "photo" | "video"; durationSeconds: number | null }> }> }> };
export type PublicPhotoVariant = "thumb" | "original";
type PublicMediaTiming = { shareResolveMs: number; handleValidationMs: number; mediaLookupMs: number; storageDownloadMs: number };

function handleSecret() { const value = process.env.PUBLIC_EXPEDITION_MEDIA_SECRET; if (!value) throw new Error("Public expedition media signing is not configured."); return value; }
function mediaHandle(slug: string, mediaId: string) { return createHmac("sha256", handleSecret()).update(`${slug}:${mediaId}`).digest("base64url"); }
async function resolveShare(slug: string) { if (!/^[A-Za-z0-9_-]{32,128}$/.test(slug)) return null; const admin = createAdminClient(); const [{ data, error }, { data: publicHeader, error: publicError }] = await Promise.all([admin.rpc("resolve_public_expedition_share", { requested_slug: slug }), admin.rpc("get_public_expedition_report", { requested_slug: slug })]); const row = !error && Array.isArray(data) ? data[0] as { project_id?: string; owner_id?: string } | undefined : undefined; const header = !publicError && publicHeader && typeof publicHeader === "object" && !Array.isArray(publicHeader) ? publicHeader as { name?: unknown; status?: unknown; startDate?: unknown; endDate?: unknown } : null; return row?.project_id && row.owner_id && typeof header?.name === "string" && (header.status === "completed" || header.status === "archived") ? { admin, projectId: row.project_id, ownerId: row.owner_id, publicHeader: { name: header.name, status: header.status as "completed" | "archived", startDate: typeof header.startDate === "string" ? header.startDate : null, endDate: typeof header.endDate === "string" ? header.endDate : null } } : null; }

async function resolveMediaShare(slug: string) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(slug)) return null;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("resolve_public_expedition_share", { requested_slug: slug });
  const row = !error && Array.isArray(data) ? data[0] as { project_id?: string } | undefined : undefined;
  return row?.project_id ? { admin, projectId: row.project_id } : null;
}

export async function loadPublicExpeditionReport(slug: string): Promise<PublicExpeditionReport | null> {
  const resolved = await resolveShare(slug); if (!resolved) return null;
  const project = await getUserProject(resolved.admin, resolved.ownerId, resolved.projectId); if (!project || (project.status !== "completed" && project.status !== "archived")) return null;
  const evidence = await listProjectDayTrackEvidence(resolved.admin, resolved.ownerId, resolved.projectId); for (const day of project.days) day.trackEvidence = evidence.filter((track) => track.projectDayId === day.id);
  const full = buildProjectCompletionSummary(project);
  const summary: PublicSummary = { totalDays: full.totalDays, daysWithGpsEvidence: full.daysWithGpsEvidence, uniqueTrackCount: full.uniqueTrackCount, totalDistanceM: full.totalDistanceM, totalElevationGainM: full.totalElevationGainM, totalDurationSeconds: full.totalDurationSeconds, plannedMountainCount: full.plannedMountainCount, verifiedMountainCount: full.verifiedMountainCount, likelyMountainCount: full.likelyMountainCount, journalEntryCount: full.journalEntryCount, photoCount: full.photoCount, videoCount: full.videoCount };
  return { name: resolved.publicHeader.name, status: resolved.publicHeader.status, startDate: resolved.publicHeader.startDate, endDate: resolved.publicHeader.endDate, summary,
    mountains: project.mountains.map((mountain) => ({ name: mountain.nameDe ?? mountain.name ?? "Mountain", state: full.mountainEvidence.find((item) => item.mountainId === mountain.id)?.state ?? "no-evidence" })),
    days: project.days.map((day) => ({ number: day.dayNumber, date: day.date, title: day.title, plannedMountains: day.mountains.map((mountain) => mountain.nameDe ?? mountain.name ?? "Mountain"), tracks: day.trackEvidence.map((track) => ({ title: track.title, distanceM: track.distanceM, durationSeconds: track.durationSeconds, elevationGainM: track.elevationGainM, verification: track.gpsVerified ? "verified" : track.detectedMountainId === null ? "not-detected" : "likely" })), journal: project.journalEntries.filter((entry) => entry.projectDayId === day.id).map((entry) => ({ date: entry.entryDate, title: entry.title, body: entry.body, media: entry.media.map((media) => ({ handle: mediaHandle(slug, media.id), type: media.mediaType, durationSeconds: media.durationSeconds })) })) })) };
}

export async function resolvePublicPhoto(slug: string, handle: string, variant: PublicPhotoVariant) {
  const timing: PublicMediaTiming = { shareResolveMs: 0, handleValidationMs: 0, mediaLookupMs: 0, storageDownloadMs: 0 };
  if (!/^[A-Za-z0-9_-]{43}$/.test(handle)) return null;
  const shareStarted = performance.now(); const resolved = await resolveMediaShare(slug); timing.shareResolveMs = performance.now() - shareStarted; if (!resolved) return null;
  const lookupStarted = performance.now();
  const { data } = await resolved.admin.from("expedition_project_journal_media").select("id,storage_path,mime_type,size_bytes").eq("project_id", resolved.projectId).eq("media_type", "photo").limit(1000);
  timing.mediaLookupMs = performance.now() - lookupStarted;
  const validationStarted = performance.now(); const media = (data ?? []).find((item) => { const expected = Buffer.from(mediaHandle(slug, String(item.id))); const supplied = Buffer.from(handle); return expected.length === supplied.length && timingSafeEqual(expected, supplied); }); timing.handleValidationMs = performance.now() - validationStarted;
  if (!media || !["image/jpeg", "image/png", "image/webp"].includes(String(media.mime_type)) || Number(media.size_bytes) > 10 * 1024 * 1024) return null;
  const downloadStarted = performance.now();
  const options = variant === "thumb" ? { transform: { width: 256, height: 256, resize: "contain" as const, quality: 75, format: "origin" as const } } : {};
  const { data: blob, error } = await resolved.admin.storage.from("expedition-media").download(String(media.storage_path), options, { cache: "no-store" }); timing.storageDownloadMs = performance.now() - downloadStarted;
  const mimeType = blob?.type || String(media.mime_type);
  return error || !blob || !["image/jpeg", "image/png", "image/webp"].includes(mimeType) ? null : { blob, mimeType, timing };
}
