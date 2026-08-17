import type { UserGpsPosition } from "./types";

export type RecordedTrackPoint = {
  latitude: number;
  longitude: number;
  altitudeM: number | null;
  accuracyM: number;
  timestamp: number;
  startsNewSegment?: boolean;
};

export type TrackRecordingStatus =
  | "idle"
  | "recording"
  | "paused"
  | "finished";

export type RecordedTrack = {
  startedAt: number;
  finishedAt: number | null;
  points: RecordedTrackPoint[];
};

export type TrackMovementState = "stationary" | "moving";

export type MovementEvidence = {
  first: RecordedTrackPoint;
  previous: RecordedTrackPoint;
  last: RecordedTrackPoint;
  count: number;
};

export type TrackSampleCounters = {
  rawSamples: number;
  acceptedPoints: number;
  rejectedAccuracy: number;
  rejectedDuplicate: number;
  rejectedTooClose: number;
  rejectedUnconfirmed: number;
  rejectedImplausibleSpeed: number;
};

export type TrackPointRejectionReason =
  | "accuracy"
  | "duplicate"
  | "too-close"
  | "implausible-speed"
  | "unconfirmed";

export type TrackRecorderState = {
  status: TrackRecordingStatus;
  startedAt: number | null;
  finishedAt: number | null;
  points: RecordedTrackPoint[];
  activeDurationMs: number;
  segmentStartedAt: number | null;
  lastRejectedReason: TrackPointRejectionReason | null;
  pendingSegmentStart: boolean;
  movementState: TrackMovementState;
  movementEvidence: MovementEvidence | null;
  subThresholdStreak: number;
  sampleCounters: TrackSampleCounters;
  stationaryAnchor: RecordedTrackPoint | null;
  previewPoints: RecordedTrackPoint[];
};

export type TrackRecorderAction =
  | { type: "start"; now: number }
  | { type: "acceptPosition"; position: UserGpsPosition }
  | { type: "pause"; now: number }
  | { type: "resume"; now: number }
  | { type: "finish"; now: number }
  | { type: "restoreFinished"; snapshot: FinishedRecordingSnapshot }
  | { type: "reset" };

export type FinishedRecordingSnapshot = {
  points: RecordedTrackPoint[];
  startedAt: number;
  finishedAt: number;
  activeDurationMs: number;
};

export type TrackStats = {
  pointCount: number;
  distanceM: number;
  elevationGainM: number;
  hasAltitudeData: boolean;
};

/** Maximum accepted horizontal accuracy (m) for a recorded GPS point. */
export const MAX_GPS_ACCURACY_M = 50;
/**
 * Floor of the dynamic movement threshold (m). A candidate must be at
 * least this far from the last accepted point before it can count as
 * movement evidence; smaller displacements are indistinguishable from
 * stationary GPS drift.
 */
export const BASE_MIN_MOVEMENT_M = 8;
/**
 * The movement threshold also scales with the worse of the two fix
 * accuracies: a fix with ±15 m accuracy must not be read as 5 m of
 * genuine movement.
 */
export const ACCURACY_THRESHOLD_FACTOR = 0.8;
/** Maximum plausible hiking speed (km/h) between consecutive accepted points. */
export const MAX_IMPLIED_SPEED_KMH = 25;
/** Consecutive coherent movement samples required before a point is accepted. */
export const MOVEMENT_CONFIRM_SAMPLES = 3;
/** Evidence older than this (ms) is discarded; slow drift must not accumulate. */
export const MOVEMENT_CONFIRM_MAX_SPAN_MS = 20_000;
/** Allowed distance regression (m) of a candidate vs. the first evidence sample. */
export const MOVEMENT_MONOTONE_SLACK_M = 2;
/** Max bearing change (deg) between consecutive evidence samples. */
export const MAX_DIRECTION_CHANGE_DEG = 120;
/** Consecutive sub-threshold samples after which the informational state flips to stationary. */
export const MOVEMENT_STOP_SAMPLES = 5;
/** Stationary anchor release radius (m). Must sustain net displacement outside this
 *  radius from the anchor before confirming movement. Prevents anchor chasing noise. */
export const STATIONARY_ANCHOR_RELEASE_RADIUS_M = 15;
/** Moving mode threshold floor (m). Smaller than BASE_MIN_MOVEMENT_M for confirmed movement. */
export const MOVING_MODE_MIN_MOVEMENT_M = 5;
export const ELEVATION_GAIN_JITTER_THRESHOLD_M = 3;
export const MIN_TRACK_POINTS = 2;
export const EARTH_RADIUS_M = 6_371_000;

export function createInitialSampleCounters(): TrackSampleCounters {
  return {
    rawSamples: 0,
    acceptedPoints: 0,
    rejectedAccuracy: 0,
    rejectedDuplicate: 0,
    rejectedTooClose: 0,
    rejectedUnconfirmed: 0,
    rejectedImplausibleSpeed: 0,
  };
}

export function createInitialRecorderState(): TrackRecorderState {
  return {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    points: [],
    activeDurationMs: 0,
    segmentStartedAt: null,
    lastRejectedReason: null,
    pendingSegmentStart: false,
    movementState: "stationary",
    movementEvidence: null,
    subThresholdStreak: 0,
    sampleCounters: createInitialSampleCounters(),
    stationaryAnchor: null,
    previewPoints: [],
  };
}

export function normalizeTrackPoint(
  position: UserGpsPosition,
): RecordedTrackPoint | null {
  const { latitude, longitude, altitudeM, accuracyM, timestamp } = position;

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return null;
  }

  if (
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  if (!Number.isFinite(accuracyM) || accuracyM < 0) {
    return null;
  }

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  const normalizedAltitude =
    altitudeM !== null && Number.isFinite(altitudeM)
      ? altitudeM
      : null;

  return {
    latitude,
    longitude,
    altitudeM: normalizedAltitude,
    accuracyM,
    timestamp,
  };
}

export function isDuplicateTrackPoint(
  previousPoint: RecordedTrackPoint,
  nextPoint: RecordedTrackPoint,
): boolean {
  return (
    previousPoint.latitude === nextPoint.latitude &&
    previousPoint.longitude === nextPoint.longitude &&
    previousPoint.timestamp === nextPoint.timestamp
  );
}

/**
 * Dynamic minimum movement threshold. Movement cannot be trusted below
 * the worse of the two fix accuracies, scaled by
 * ACCURACY_THRESHOLD_FACTOR, and never below BASE_MIN_MOVEMENT_M.
 */
export function movementThresholdM(
  previousAccuracyM: number,
  candidateAccuracyM: number,
): number {
  const worseAccuracyM = Math.max(
    previousAccuracyM,
    candidateAccuracyM,
  );

  return Math.max(
    BASE_MIN_MOVEMENT_M,
    worseAccuracyM * ACCURACY_THRESHOLD_FACTOR,
  );
}

export function bearingDegrees(
  fromPoint: RecordedTrackPoint,
  toPoint: RecordedTrackPoint,
): number {
  const fromLatitude = degreesToRadians(fromPoint.latitude);
  const toLatitude = degreesToRadians(toPoint.latitude);
  const longitudeDifference = degreesToRadians(
    toPoint.longitude - fromPoint.longitude,
  );

  const y = Math.sin(longitudeDifference) * Math.cos(toLatitude);
  const x =
    Math.cos(fromLatitude) * Math.sin(toLatitude) -
    Math.sin(fromLatitude) *
      Math.cos(toLatitude) *
      Math.cos(longitudeDifference);

  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function bearingDifferenceDegrees(
  firstBearing: number,
  secondBearing: number,
): number {
  const difference = Math.abs(firstBearing - secondBearing) % 360;

  return difference > 180 ? 360 - difference : difference;
}

/**
 * Extends or restarts the movement evidence window for a candidate that
 * exceeds the movement threshold. The window restarts when the candidate
 * is too old (slow drift must not accumulate), regresses toward the last
 * accepted point (a spike), or changes direction sharply (jitter).
 */
export function extendMovementEvidence(
  evidence: MovementEvidence | null,
  lastAcceptedPoint: RecordedTrackPoint,
  candidatePoint: RecordedTrackPoint,
): MovementEvidence {
  if (!evidence) {
    return {
      first: candidatePoint,
      previous: candidatePoint,
      last: candidatePoint,
      count: 1,
    };
  }

  const stale =
    candidatePoint.timestamp - evidence.first.timestamp >
    MOVEMENT_CONFIRM_MAX_SPAN_MS;

  const firstDistanceM = haversineDistanceMeters(
    lastAcceptedPoint,
    evidence.first,
  );

  const candidateDistanceM = haversineDistanceMeters(
    lastAcceptedPoint,
    candidatePoint,
  );

  const regressed =
    candidateDistanceM <
    firstDistanceM - MOVEMENT_MONOTONE_SLACK_M;

  const directionChanged =
    bearingDifferenceDegrees(
      bearingDegrees(lastAcceptedPoint, evidence.previous),
      bearingDegrees(lastAcceptedPoint, candidatePoint),
    ) > MAX_DIRECTION_CHANGE_DEG;

  if (stale || regressed || directionChanged) {
    return {
      first: candidatePoint,
      previous: candidatePoint,
      last: candidatePoint,
      count: 1,
    };
  }

  return {
    first: evidence.first,
    previous: evidence.last,
    last: candidatePoint,
    count: evidence.count + 1,
  };
}

function withCounter(
  state: TrackRecorderState,
  counters: Partial<TrackSampleCounters>,
): TrackRecorderState {
  return {
    ...state,
    sampleCounters: { ...state.sampleCounters, ...counters },
  };
}

export function trackRecorderReducer(
  state: TrackRecorderState,
  action: TrackRecorderAction,
): TrackRecorderState {
  switch (action.type) {
    case "start": {
      if (state.status !== "idle") {
        return state;
      }

      return {
        status: "recording",
        startedAt: action.now,
        finishedAt: null,
        points: [],
        activeDurationMs: 0,
        segmentStartedAt: action.now,
        lastRejectedReason: null,
        pendingSegmentStart: false,
        movementState: "stationary",
        movementEvidence: null,
        subThresholdStreak: 0,
        sampleCounters: createInitialSampleCounters(),
        stationaryAnchor: null,
        previewPoints: [],
      };
    }

    case "acceptPosition": {
      if (state.status !== "recording") {
        return state;
      }

      const rawSamples = state.sampleCounters.rawSamples + 1;

      const point = normalizeTrackPoint(action.position);

      if (!point) {
        return withCounter(state, { rawSamples });
      }

      // Preview point always added for immediate visual feedback
      const newPreviewPoints = [...state.previewPoints, point];

      if (point.accuracyM > MAX_GPS_ACCURACY_M) {
        return {
          ...withCounter(state, {
            rawSamples,
            rejectedAccuracy:
              state.sampleCounters.rejectedAccuracy + 1,
          }),
          previewPoints: newPreviewPoints,
          movementEvidence: null,
          lastRejectedReason: "accuracy",
        };
      }

      const lastPoint =
        state.points[state.points.length - 1];

      if (!lastPoint) {
        return {
          ...state,
          points: [...state.points, point],
          previewPoints: newPreviewPoints,
          stationaryAnchor: point,
          pendingSegmentStart: false,
          movementState: "stationary",
          movementEvidence: null,
          subThresholdStreak: 0,
          lastRejectedReason: null,
          sampleCounters: {
            ...state.sampleCounters,
            rawSamples,
            acceptedPoints: state.sampleCounters.acceptedPoints + 1,
          },
        };
      }

      if (state.pendingSegmentStart) {
        return {
          ...state,
          points: [
            ...state.points,
            { ...point, startsNewSegment: true },
          ],
          previewPoints: [...state.previewPoints, { ...point, startsNewSegment: true }],
          stationaryAnchor: point,
          pendingSegmentStart: false,
          movementState: "stationary",
          movementEvidence: null,
          subThresholdStreak: 0,
          lastRejectedReason: null,
          sampleCounters: {
            ...state.sampleCounters,
            rawSamples,
            acceptedPoints: state.sampleCounters.acceptedPoints + 1,
          },
        };
      }

      if (isDuplicateTrackPoint(lastPoint, point)) {
        return {
          ...withCounter(state, {
            rawSamples,
            rejectedDuplicate:
              state.sampleCounters.rejectedDuplicate + 1,
          }),
          previewPoints: newPreviewPoints,
          movementEvidence: null,
          lastRejectedReason: "duplicate",
        };
      }

      const distanceM = haversineDistanceMeters(
        lastPoint,
        point,
      );

      const elapsedSeconds =
        (point.timestamp - lastPoint.timestamp) / 1000;

      const impliedSpeedKmh =
        elapsedSeconds > 0
          ? (distanceM / elapsedSeconds) * 3.6
          : Number.POSITIVE_INFINITY;

      if (impliedSpeedKmh > MAX_IMPLIED_SPEED_KMH) {
        return {
          ...withCounter(state, {
            rawSamples,
            rejectedImplausibleSpeed:
              state.sampleCounters.rejectedImplausibleSpeed + 1,
          }),
          previewPoints: newPreviewPoints,
          movementEvidence: null,
          lastRejectedReason: "implausible-speed",
        };
      }

      // Stationary mode: require sustained displacement from anchor
      if (state.movementState === "stationary") {
        const anchor = state.stationaryAnchor ?? lastPoint;
        const anchorDistanceM = haversineDistanceMeters(anchor, point);

        // Check if we have sustained movement outside the release radius
        if (anchorDistanceM >= STATIONARY_ANCHOR_RELEASE_RADIUS_M) {
          const movementEvidence = extendMovementEvidence(
            state.movementEvidence,
            lastPoint,
            point,
          );

          if (
            movementEvidence.count >= MOVEMENT_CONFIRM_SAMPLES &&
            haversineDistanceMeters(
              movementEvidence.first,
              movementEvidence.last,
            ) >= STATIONARY_ANCHOR_RELEASE_RADIUS_M
          ) {
            // Confirmed movement: accept the point, switch to moving mode
            return {
              ...state,
              points: [...state.points, movementEvidence.last],
              previewPoints: newPreviewPoints,
              movementState: "moving",
              movementEvidence: null,
              stationaryAnchor: null,
              subThresholdStreak: 0,
              lastRejectedReason: null,
              sampleCounters: {
                ...state.sampleCounters,
                rawSamples,
                acceptedPoints: state.sampleCounters.acceptedPoints + 1,
              },
            };
          }

          // Still building evidence - add to preview but not confirmed
          return {
            ...withCounter(state, {
              rawSamples,
              rejectedUnconfirmed:
                state.sampleCounters.rejectedUnconfirmed + 1,
            }),
            previewPoints: newPreviewPoints,
            movementEvidence,
            subThresholdStreak: 0,
            lastRejectedReason: "unconfirmed",
          };
        }

        // Within release radius - stationary jitter, don't accumulate
        return {
          ...withCounter(state, {
            rawSamples,
            rejectedTooClose:
              state.sampleCounters.rejectedTooClose + 1,
          }),
          previewPoints: newPreviewPoints,
          movementEvidence: null,
          subThresholdStreak: 0,
          lastRejectedReason: "too-close",
        };
      }

      // Moving mode: use smaller threshold for confirmed points
      const movingThresholdM = Math.max(
        MOVING_MODE_MIN_MOVEMENT_M,
        movementThresholdM(lastPoint.accuracyM, point.accuracyM),
      );

      if (distanceM < movingThresholdM) {
        const subThresholdStreak = state.subThresholdStreak + 1;

        // Check for transition back to stationary
        if (subThresholdStreak >= MOVEMENT_STOP_SAMPLES) {
          // Establish new stationary anchor at the last confirmed point
          return {
            ...withCounter(state, {
              rawSamples,
              rejectedTooClose:
                state.sampleCounters.rejectedTooClose + 1,
            }),
            previewPoints: newPreviewPoints,
            movementState: "stationary",
            movementEvidence: null,
            stationaryAnchor: lastPoint,
            subThresholdStreak: 0,
            lastRejectedReason: "too-close",
          };
        }

        return {
          ...withCounter(state, {
            rawSamples,
            rejectedTooClose:
              state.sampleCounters.rejectedTooClose + 1,
          }),
          previewPoints: newPreviewPoints,
          movementState: "moving",
          movementEvidence: null,
          subThresholdStreak,
          lastRejectedReason: "too-close",
        };
      }

      // Distance exceeds moving threshold - confirm the point
      const movementEvidence = extendMovementEvidence(
        state.movementEvidence,
        lastPoint,
        point,
      );

      if (
        movementEvidence.count >= MOVEMENT_CONFIRM_SAMPLES &&
        haversineDistanceMeters(
          movementEvidence.first,
          movementEvidence.last,
        ) >= movingThresholdM
      ) {
        return {
          ...state,
          points: [...state.points, movementEvidence.last],
          previewPoints: newPreviewPoints,
          movementState: "moving",
          movementEvidence: null,
          subThresholdStreak: 0,
          lastRejectedReason: null,
          sampleCounters: {
            ...state.sampleCounters,
            rawSamples,
            acceptedPoints: state.sampleCounters.acceptedPoints + 1,
          },
        };
      }

      const subThresholdStreak = state.subThresholdStreak + 1;

      if (subThresholdStreak >= MOVEMENT_STOP_SAMPLES) {
        return {
          ...withCounter(state, {
            rawSamples,
            rejectedUnconfirmed:
              state.sampleCounters.rejectedUnconfirmed + 1,
          }),
          previewPoints: newPreviewPoints,
          movementState: "stationary",
          movementEvidence: null,
          stationaryAnchor: lastPoint,
          subThresholdStreak: 0,
          lastRejectedReason: "unconfirmed",
        };
      }

      return {
        ...withCounter(state, {
          rawSamples,
          rejectedUnconfirmed:
            state.sampleCounters.rejectedUnconfirmed + 1,
        }),
        previewPoints: newPreviewPoints,
        movementEvidence,
        subThresholdStreak,
        lastRejectedReason: "unconfirmed",
      };
    }

    case "pause": {
      if (
        state.status !== "recording" ||
        state.segmentStartedAt === null
      ) {
        return state;
      }

      return {
        ...state,
        status: "paused",
        activeDurationMs:
          state.activeDurationMs +
          Math.max(0, action.now - state.segmentStartedAt),
        segmentStartedAt: null,
        lastRejectedReason: null,
        movementEvidence: null,
        subThresholdStreak: 0,
        previewPoints: [],
        stationaryAnchor: null,
      };
    }

    case "resume": {
      if (state.status !== "paused") {
        return state;
      }

      return {
        ...state,
        status: "recording",
        segmentStartedAt: action.now,
        lastRejectedReason: null,
        pendingSegmentStart: true,
        movementState: "stationary",
        movementEvidence: null,
        subThresholdStreak: 0,
        previewPoints: [],
        stationaryAnchor: null,
      };
    }

    case "finish": {
      if (
        state.status !== "recording" &&
        state.status !== "paused"
      ) {
        return state;
      }

      if (state.points.length < MIN_TRACK_POINTS) {
        return state;
      }

      const activeDurationMs =
        state.status === "recording" &&
        state.segmentStartedAt !== null
          ? state.activeDurationMs +
            Math.max(0, action.now - state.segmentStartedAt)
          : state.activeDurationMs;

      return {
        ...state,
        status: "finished",
        finishedAt: action.now,
        activeDurationMs,
        segmentStartedAt: null,
        lastRejectedReason: null,
      };
    }

    case "restoreFinished": {
      const { snapshot } = action;
      const lastPoint = snapshot.points[snapshot.points.length - 1] ?? null;

      return {
        status: "finished",
        startedAt: snapshot.startedAt,
        finishedAt: snapshot.finishedAt,
        points: snapshot.points,
        activeDurationMs: snapshot.activeDurationMs,
        segmentStartedAt: null,
        lastRejectedReason: null,
        pendingSegmentStart: false,
        movementState: "stationary",
        movementEvidence: null,
        subThresholdStreak: 0,
        sampleCounters: {
          ...createInitialSampleCounters(),
          acceptedPoints: snapshot.points.length,
        },
        stationaryAnchor: lastPoint,
        previewPoints: [],
      };
    }

    case "reset": {
      return createInitialRecorderState();
    }
  }
}

export function getActiveDurationMs(
  state: TrackRecorderState,
  now: number,
): number {
  if (
    state.status === "recording" &&
    state.segmentStartedAt !== null
  ) {
    return (
      state.activeDurationMs +
      Math.max(0, now - state.segmentStartedAt)
    );
  }

  return state.activeDurationMs;
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function haversineDistanceMeters(
  firstPoint: RecordedTrackPoint,
  secondPoint: RecordedTrackPoint,
): number {
  const firstLatitude = degreesToRadians(
    firstPoint.latitude,
  );

  const secondLatitude = degreesToRadians(
    secondPoint.latitude,
  );

  const latitudeDifference = degreesToRadians(
    secondPoint.latitude - firstPoint.latitude,
  );

  const longitudeDifference = degreesToRadians(
    secondPoint.longitude - firstPoint.longitude,
  );

  const haversine =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDifference / 2) ** 2;

  const centralAngle =
    2 *
    Math.atan2(
      Math.sqrt(haversine),
      Math.sqrt(1 - haversine),
    );

  return EARTH_RADIUS_M * centralAngle;
}

export function computeTrackStats(
  points: RecordedTrackPoint[],
): TrackStats {
  let distanceM = 0;
  let elevationGainM = 0;
  let hasAltitudeData = false;

  for (
    let pointIndex = 1;
    pointIndex < points.length;
    pointIndex += 1
  ) {
    const previousPoint = points[pointIndex - 1];
    const currentPoint = points[pointIndex];

    if (previousPoint.altitudeM !== null) {
      hasAltitudeData = true;
    }

    if (currentPoint.altitudeM !== null) {
      hasAltitudeData = true;
    }

    if (currentPoint.startsNewSegment) {
      continue;
    }

    distanceM += haversineDistanceMeters(
      previousPoint,
      currentPoint,
    );

    if (
      previousPoint.altitudeM !== null &&
      currentPoint.altitudeM !== null
    ) {
      const elevationDifference =
        currentPoint.altitudeM - previousPoint.altitudeM;

      if (
        elevationDifference >=
        ELEVATION_GAIN_JITTER_THRESHOLD_M
      ) {
        elevationGainM += elevationDifference;
      }
    }
  }

  if (points.length === 1 && points[0].altitudeM !== null) {
    hasAltitudeData = true;
  }

  return {
    pointCount: points.length,
    distanceM,
    elevationGainM,
    hasAltitudeData,
  };
}

export function buildTrackLineGeoJson(
  points: RecordedTrackPoint[],
): GeoJSON.FeatureCollection {
  if (points.length < MIN_TRACK_POINTS) {
    return {
      type: "FeatureCollection",
      features: [],
    };
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          source: "user_recorded",
          point_count: points.length,
        },
        geometry: {
          type: "LineString",
          coordinates: points.map((point) => [
            point.longitude,
            point.latitude,
          ]),
        },
      },
    ],
  };
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildGpxXml(
  points: RecordedTrackPoint[],
  trackName: string,
): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Mountain Tracker" xmlns="http://www.topografix.com/GPX/1/1">',
    "  <trk>",
    `    <name>${escapeXml(trackName)}</name>`,
    "    <trkseg>",
  ];

  for (const point of points) {
    const elevationLine =
      point.altitudeM !== null
        ? `\n        <ele>${point.altitudeM.toFixed(1)}</ele>`
        : "";

    lines.push(
      `      <trkpt lat="${point.latitude.toFixed(7)}" lon="${point.longitude.toFixed(7)}">${elevationLine}`,
      `        <time>${new Date(point.timestamp).toISOString()}</time>`,
      "      </trkpt>",
    );
  }

  lines.push("    </trkseg>", "  </trk>", "</gpx>", "");

  return lines.join("\n");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function buildGpxFilename(startedAt: number): string {
  const date = new Date(startedAt);

  return `mountain-tracker-track-${date.getFullYear()}-${pad2(
    date.getMonth() + 1,
  )}-${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(
    date.getMinutes(),
  )}.gpx`;
}

export function buildGpxTrackName(startedAt: number): string {
  const date = new Date(startedAt);

  return `mountain-tracker-track-${date.getFullYear()}-${pad2(
    date.getMonth() + 1,
  )}-${pad2(date.getDate())}`;
}

export function usesKilometers(meters: number): boolean {
  return meters >= 1000;
}

export function formatDistanceValue(
  meters: number,
  locale: string,
): string {
  const wholeMeters = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  });

  const kilometers = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  if (meters < 1000) {
    return wholeMeters.format(Math.round(meters));
  }

  return kilometers.format(meters / 1000);
}

export function getDurationParts(
  durationMs: number,
): { hours: number; minutes: number; seconds: number } {
  const totalSeconds = Math.max(
    0,
    Math.floor(durationMs / 1000),
  );

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return { hours, minutes, seconds };
}

export type VisualPosition = {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
} | null;

/**
 * Computes the visual position for the user-location dot.
 * When stationary, locks to the stationary anchor.
 * When moving, follows the latest GPS position.
 */
export function getVisualPosition(
  state: TrackRecorderState,
  latestRawPosition: UserGpsPosition | null,
): VisualPosition {
  // If we have a stationary anchor and are in stationary mode, use the anchor
  if (
    state.movementState === "stationary" &&
    state.stationaryAnchor !== null
  ) {
    return {
      latitude: state.stationaryAnchor.latitude,
      longitude: state.stationaryAnchor.longitude,
      accuracyM: state.stationaryAnchor.accuracyM,
    };
  }

  // Otherwise, use the latest raw GPS position (or latest preview point)
  if (latestRawPosition !== null) {
    return {
      latitude: latestRawPosition.latitude,
      longitude: latestRawPosition.longitude,
      accuracyM: latestRawPosition.accuracyM,
    };
  }

  // Fallback to latest preview point if available
  if (state.previewPoints.length > 0) {
    const latestPreview = state.previewPoints[state.previewPoints.length - 1];
    return {
      latitude: latestPreview.latitude,
      longitude: latestPreview.longitude,
      accuracyM: latestPreview.accuracyM,
    };
  }

  return null;
}
