import type { ProjectDayTrackEvidence, ProjectTrackVerificationState } from "./types.ts";

export function deriveProjectTrackVerification(track: Pick<ProjectDayTrackEvidence, "gpsVerified" | "processingStatus" | "detectedMountainId" | "detectionConfidence" | "detectionStatus">): ProjectTrackVerificationState {
  if (track.processingStatus !== "ready") return "unavailable";
  if (track.gpsVerified && track.detectionStatus === "detected" && track.detectedMountainId !== null) return "verified";
  if (track.detectionStatus === "detected" && track.detectedMountainId !== null && track.detectionConfidence !== null && track.detectionConfidence > 0) return "likely";
  return track.detectionStatus === "not_found" || track.detectedMountainId === null ? "not-detected" : "unavailable";
}
