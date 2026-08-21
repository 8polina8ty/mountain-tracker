import type { SummitWeatherDaily } from "@/Lib/weather/types";

export const PROJECT_STATUSES = [
  "planning",
  "ready",
  "active",
  "completed",
  "archived",
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type MountainId = number;

export type ProjectMountain = {
  id: MountainId;
  name: string | null;
  nameDe: string | null;
  heightM: number;
  latitude: number | null;
  longitude: number | null;
  sortOrder: number;
};

export type ProjectDayMountain = ProjectMountain;

export type ProjectTrackVerificationState = "verified" | "likely" | "not-detected" | "unavailable";
export type ProjectMountainEvidenceState = "verified" | "likely" | "not-detected" | "no-evidence";

export type ProjectDayTrackEvidence = {
  relationId: string;
  projectDayId: string;
  userId: string;
  activityId: number;
  title: string | null;
  sourceType: string;
  startedAt: string | null;
  distanceM: number | null;
  durationSeconds: number | null;
  elevationGainM: number | null;
  processingStatus: string;
  detectedMountainId: number | null;
  detectedMountainName: string | null;
  detectionConfidence: number | null;
  detectionStatus: string | null;
  gpsVerified: boolean;
  geoJsonPath: string | null;
};

export type ProjectTrackPickerOption = Omit<ProjectDayTrackEvidence, "relationId" | "projectDayId" | "userId">;

export const PROJECT_JOURNAL_MEDIA_TYPES = ["photo", "video"] as const;
export type ProjectJournalMediaType = (typeof PROJECT_JOURNAL_MEDIA_TYPES)[number];

export type ProjectJournalMedia = {
  id: string;
  journalEntryId: string;
  projectId: string;
  userId: string;
  mediaType: ProjectJournalMediaType;
  storagePath: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationSeconds: number | null;
  sortOrder: number;
  createdAt: string;
};

export type ProjectJournalMediaUploadInput = {
  mediaId?: string;
  projectId: string;
  journalEntryId: string;
  file: File;
  width: number;
  height: number;
  durationSeconds: number | null;
  sortOrder: number;
};

export type ProjectJournalMediaValidationReason =
  | "empty-file"
  | "invalid-mime"
  | "signature-mismatch"
  | "decoding-unavailable"
  | "decode-failed"
  | "photo-too-large"
  | "photo-dimensions"
  | "photo-pixels"
  | "photo-duration"
  | "video-too-large"
  | "video-dimensions"
  | "video-duration"
  | "invalid-sort-order";

export type ProjectJournalMediaValidationResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; reason: ProjectJournalMediaValidationReason };

export type ProjectJournalMediaFailureReason =
  | "auth"
  | "validation"
  | "ownership"
  | "upload"
  | "storage"
  | "metadata"
  | "cleanup-required"
  | "conflict"
  | "limit"
  | "not-found"
  | "unknown";

export type ProjectJournalMediaMutationResult<T = undefined> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: ProjectJournalMediaFailureReason;
      message: string;
      retryable: boolean;
      diagnostic?: import("./mediaDiagnostics.ts").ProjectMediaDiagnostic;
    };

export type ProjectJournalMediaDelivery = ProjectJournalMedia & {
  signedUrl: string | null;
  deliveryState: "ready" | "unavailable";
};

export type ProjectDay = {
  id: string;
  projectId: string;
  dayNumber: number;
  date: string | null;
  title: string | null;
  notes: string | null;
  mountains: ProjectDayMountain[];
  trackEvidence: ProjectDayTrackEvidence[];
  createdAt: string;
  updatedAt: string;
};

export type ProjectJournalEntry = {
  id: string;
  projectId: string;
  userId: string;
  projectDayId: string | null;
  entryDate: string;
  title: string | null;
  body: string;
  media: ProjectJournalMedia[];
  createdAt: string;
  updatedAt: string;
};

export type ProjectJournalCursor = { entryDate: string; id: string };
export type ProjectJournalPage = { entries: ProjectJournalEntry[]; nextCursor: ProjectJournalCursor | null };
export type ProjectJournalScopeStats = { entryCount: number; mediaCount: number; photoCount: number; videoCount: number };
export type ProjectJournalWorkspaceStats = {
  total: ProjectJournalScopeStats;
  project: ProjectJournalScopeStats;
  days: Record<string, ProjectJournalScopeStats>;
};

export type ExpeditionProject = {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  startDate: string | null;
  endDate: string | null;
  mountains: ProjectMountain[];
  days: ProjectDay[];
  journalEntries: ProjectJournalEntry[];
  createdAt: string;
  updatedAt: string;
};

export type ProjectWorkspaceLoad = {
  project: ExpeditionProject;
  journalCursor: ProjectJournalCursor | null;
  journalStats: ProjectJournalWorkspaceStats;
};

export type ExpeditionProjectSummary = Omit<
  ExpeditionProject,
  "days" | "journalEntries"
> & {
  dayCount: number;
  journalEntryCount: number;
};

export type ProjectPickerOption = {
  id: string;
  name: string;
  status: ProjectStatus;
  startDate: string | null;
  endDate: string | null;
  alreadyContainsMountain: boolean;
};

export type ProjectDayWeather = {
  state: "available" | "outside-horizon" | "unavailable";
  forecast: SummitWeatherDaily | null;
};

export type ProjectWeatherSummary = {
  availableDayCount: number;
  availableMountainCount: number;
  assignedDayCount: number;
  outsideHorizonDayCount: number;
  unavailableDayCount: number;
  totalDayCount: number;
};

export type ProjectCompletionSummary = {
  readyToComplete: boolean;
  totalDays: number;
  daysWithGpsEvidence: number;
  uniqueTrackCount: number;
  unavailableTrackCount: number;
  totalDistanceM: number;
  totalElevationGainM: number;
  totalDurationSeconds: number;
  plannedMountainCount: number;
  verifiedMountainCount: number;
  likelyMountainCount: number;
  notDetectedMountainCount: number;
  noEvidenceMountainCount: number;
  journalEntryCount: number;
  photoCount: number;
  videoCount: number;
  mountainEvidence: Array<{ mountainId: MountainId; state: ProjectMountainEvidenceState }>;
};

export type CreateProjectInput = {
  name: string;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
};

export type ProjectMutationResult<T = undefined> =
  | { ok: true; data: T; outcome?: "success" | "already-applied" }
  | { ok: false; reason: "auth" | "validation" | "conflict" | "not-found" | "permission" | "archived" | "partial-failure" | "unknown" | "unauthenticated" | "invalid" | "database"; message: string };

export const PROJECT_ACTIVITY_ACTIONS = [
  "project.status_changed", "project.archived", "project.restored",
  "mountain.added", "mountain.removed", "mountain.assigned_to_day", "mountain.unassigned_from_day",
  "day.created", "day.updated", "day.deleted", "day.reordered",
  "journal.created", "journal.updated", "journal.deleted",
  "media.photo_uploaded", "media.video_uploaded", "media.deleted",
  "track.linked", "track.imported_and_linked", "track.unlinked",
  "member.joined", "member.role_changed", "member.removed", "member.left",
  "sharing.enabled", "sharing.disabled",
] as const;
export type ProjectActivityAction = (typeof PROJECT_ACTIVITY_ACTIONS)[number];
export type ProjectActivityCursor = { createdAt: string; id: string };
export type ProjectActivityItem = {
  id: string;
  actorUserId: string;
  actorName: string | null;
  actorUsername: string | null;
  actorAvatarUrl: string | null;
  actionType: ProjectActivityAction;
  resourceType: "project" | "mountain" | "day" | "journal" | "media" | "track" | "member" | "sharing";
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
};
export type ProjectActivityPage = { items: ProjectActivityItem[]; nextCursor: ProjectActivityCursor | null };
