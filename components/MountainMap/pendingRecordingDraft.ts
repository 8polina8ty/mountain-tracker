import type {
  FinishedRecordingSnapshot,
  RecordedTrackPoint,
} from "./trackRecording";

export const PENDING_RECORDING_STORAGE_KEY =
  "mountain-tracker:pending-recording:v1";

const DRAFT_VERSION = 1;
const MAX_SERIALIZED_DRAFT_LENGTH = 2_000_000;
const MAX_DRAFT_POINTS = 20_000;
const MAX_TRACK_NAME_LENGTH = 160;
const MAX_DRAFT_ACCURACY_M = 50;

export type PendingRecordingDraft = FinishedRecordingSnapshot & {
  version: typeof DRAFT_VERSION;
  trackName: string;
};

const TOP_LEVEL_KEYS = [
  "version",
  "points",
  "startedAt",
  "finishedAt",
  "activeDurationMs",
  "trackName",
] as const;

const POINT_KEYS = [
  "latitude",
  "longitude",
  "altitudeM",
  "accuracyM",
  "timestamp",
  "startsNewSegment",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function normalizePoint(value: unknown): RecordedTrackPoint | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, POINT_KEYS)) {
    return null;
  }

  const {
    latitude,
    longitude,
    altitudeM,
    accuracyM,
    timestamp,
    startsNewSegment,
  } = value;

  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    typeof accuracyM !== "number" ||
    !Number.isFinite(accuracyM) ||
    accuracyM < 0 ||
    accuracyM > MAX_DRAFT_ACCURACY_M ||
    typeof timestamp !== "number" ||
    !Number.isFinite(timestamp) ||
    timestamp <= 0 ||
    !(
      altitudeM === null ||
      (typeof altitudeM === "number" && Number.isFinite(altitudeM))
    ) ||
    !(
      startsNewSegment === undefined ||
      typeof startsNewSegment === "boolean"
    )
  ) {
    return null;
  }

  return {
    latitude,
    longitude,
    altitudeM,
    accuracyM,
    timestamp,
    ...(startsNewSegment === true ? { startsNewSegment: true } : {}),
  };
}

export function normalizePendingRecordingDraft(
  value: unknown,
): PendingRecordingDraft | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, TOP_LEVEL_KEYS)) {
    return null;
  }

  const {
    version,
    points,
    startedAt,
    finishedAt,
    activeDurationMs,
    trackName,
  } = value;

  if (
    version !== DRAFT_VERSION ||
    !Array.isArray(points) ||
    points.length < 2 ||
    points.length > MAX_DRAFT_POINTS ||
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    startedAt <= 0 ||
    typeof finishedAt !== "number" ||
    !Number.isFinite(finishedAt) ||
    finishedAt < startedAt ||
    typeof activeDurationMs !== "number" ||
    !Number.isFinite(activeDurationMs) ||
    activeDurationMs < 0 ||
    activeDurationMs > finishedAt - startedAt ||
    typeof trackName !== "string" ||
    trackName.length > MAX_TRACK_NAME_LENGTH
  ) {
    return null;
  }

  const normalizedPoints = points.map(normalizePoint);
  if (normalizedPoints.some((point) => point === null)) {
    return null;
  }

  return {
    version: DRAFT_VERSION,
    points: normalizedPoints as RecordedTrackPoint[],
    startedAt,
    finishedAt,
    activeDurationMs,
    trackName,
  };
}

export function serializePendingRecordingDraft(
  snapshot: FinishedRecordingSnapshot,
  trackName: string,
): string | null {
  const draft = normalizePendingRecordingDraft({
    version: DRAFT_VERSION,
    points: snapshot.points,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
    activeDurationMs: snapshot.activeDurationMs,
    trackName,
  });

  if (!draft) {
    return null;
  }

  const serialized = JSON.stringify(draft);
  return serialized.length <= MAX_SERIALIZED_DRAFT_LENGTH ? serialized : null;
}

export function parsePendingRecordingDraft(
  serialized: string,
): PendingRecordingDraft | null {
  if (serialized.length > MAX_SERIALIZED_DRAFT_LENGTH) {
    return null;
  }

  try {
    return normalizePendingRecordingDraft(JSON.parse(serialized));
  } catch {
    return null;
  }
}

export function persistPendingRecordingDraft(
  snapshot: FinishedRecordingSnapshot,
  trackName: string,
): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const serialized = serializePendingRecordingDraft(snapshot, trackName);
  if (!serialized) {
    return false;
  }

  try {
    window.sessionStorage.setItem(PENDING_RECORDING_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

export function loadPendingRecordingDraft(): PendingRecordingDraft | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const serialized = window.sessionStorage.getItem(
      PENDING_RECORDING_STORAGE_KEY,
    );
    if (!serialized) {
      return null;
    }

    const draft = parsePendingRecordingDraft(serialized);
    if (!draft) {
      window.sessionStorage.removeItem(PENDING_RECORDING_STORAGE_KEY);
    }
    return draft;
  } catch {
    return null;
  }
}

export function clearPendingRecordingDraft(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(PENDING_RECORDING_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted browsing modes.
  }
}
