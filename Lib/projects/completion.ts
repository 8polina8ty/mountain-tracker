import { deriveProjectTrackVerification } from "./tracks.ts";
import type { ExpeditionProject, ProjectCompletionSummary, ProjectMountainEvidenceState } from "./types.ts";

export function buildProjectCompletionSummary(project: ExpeditionProject): ProjectCompletionSummary {
  const uniqueTracks = new Map(project.days.flatMap((day) => day.trackEvidence).map((track) => [track.activityId, track]));
  const readyTracks = [...uniqueTracks.values()].filter((track) => track.processingStatus === "ready");
  const mountainEvidence = project.mountains.map((mountain) => {
    const relevantDays = project.days.filter((day) => day.mountains.some((assigned) => assigned.id === mountain.id));
    const tracks = relevantDays.flatMap((day) => day.trackEvidence);
    let state: ProjectMountainEvidenceState = "no-evidence";
    if (tracks.length > 0) {
      const matching = tracks.filter((track) => track.detectedMountainId === mountain.id).map(deriveProjectTrackVerification);
      state = matching.includes("verified") ? "verified" : matching.includes("likely") ? "likely" : "not-detected";
    }
    return { mountainId: mountain.id, state };
  });
  const media = project.journalEntries.flatMap((entry) => entry.media);
  return {
    readyToComplete: project.days.length > 0 && project.mountains.length > 0,
    totalDays: project.days.length,
    daysWithGpsEvidence: project.days.filter((day) => day.trackEvidence.length > 0).length,
    uniqueTrackCount: uniqueTracks.size,
    unavailableTrackCount: [...uniqueTracks.values()].filter((track) => track.processingStatus !== "ready").length,
    totalDistanceM: readyTracks.reduce((sum, track) => sum + (track.distanceM ?? 0), 0),
    totalElevationGainM: readyTracks.reduce((sum, track) => sum + (track.elevationGainM ?? 0), 0),
    totalDurationSeconds: readyTracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0),
    plannedMountainCount: project.mountains.length,
    verifiedMountainCount: mountainEvidence.filter((item) => item.state === "verified").length,
    likelyMountainCount: mountainEvidence.filter((item) => item.state === "likely").length,
    notDetectedMountainCount: mountainEvidence.filter((item) => item.state === "not-detected").length,
    noEvidenceMountainCount: mountainEvidence.filter((item) => item.state === "no-evidence").length,
    journalEntryCount: project.journalEntries.length,
    photoCount: media.filter((item) => item.mediaType === "photo").length,
    videoCount: media.filter((item) => item.mediaType === "video").length,
    mountainEvidence,
  };
}
