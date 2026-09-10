// Phase 12A contracts for machine-ingested, externally sourced GPX tracks.
// These types are server/offline-safe and intentionally have no dependency on
// File, DOMParser, Supabase, or any user-owned track type.

export type SourcePolicyStatus = "ALLOWED" | "REVIEW_REQUIRED" | "BLOCKED";
export type LicenseStatus = SourcePolicyStatus;

export type ImportRunState =
  | "PLANNED"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type TrackProcessingState =
  | "DISCOVERED"
  | "DOWNLOADED"
  | "PARSED"
  | "NORMALIZED"
  | "MATCHED"
  | "DEDUPLICATED"
  | "QUALIFIED"
  | "REVIEW_REQUIRED"
  | "APPROVED"
  | "REJECTED"
  | "PROCESSING_FAILED"
  | "PUBLISHED"
  | "WITHDRAWN";

export type TrackStageState = TrackProcessingState;

export type QualityStatus =
  | "PENDING"
  | "PASSED"
  | "REVIEW_REQUIRED"
  | "REJECTED";

export type PublicationStatus =
  | "NOT_EVALUATED"
  | "WITHHELD"
  | "ELIGIBLE"
  | "PUBLISHED"
  | "WITHDRAWN";

export type MountainMatchClassification = "DIRECT" | "POSSIBLE" | "REJECTED";
export type MountainMatchOutcome = "DIRECT" | "AMBIGUOUS" | "NO_SUMMIT";

export type RouteSemanticClassification =
  | "SUMMIT_ASCENT"
  | "SUMMIT_DESCENT"
  | "OUT_AND_BACK"
  | "LOOP"
  | "TRAVERSE"
  | "MULTI_SUMMIT"
  | "RIDGE_ROUTE"
  | "PASSING_NEAR_SUMMIT"
  | "NOT_MOUNTAIN_ROUTE"
  | "UNCLASSIFIED";

export type StartContextClassification =
  | "BASE_START"
  | "HUT_START"
  | "HIGH_MOUNTAIN_START"
  | "AMBIGUOUS_START"
  | "UNCLASSIFIED";

export type DeduplicationLevel =
  | "RAW_HASH"
  | "NORMALIZED_GEOMETRY"
  | "REVERSED_GEOMETRY"
  | "NEAR_DUPLICATE"
  | "ROUTE_FAMILY";

export type ClusterRelationship =
  | "CANONICAL"
  | "RAW_DUPLICATE"
  | "GEOMETRY_DUPLICATE"
  | "REVERSED_DUPLICATE"
  | "NEAR_DUPLICATE"
  | "ROUTE_FAMILY_MEMBER";

export type QualityGateCode =
  | "INVALID_GEOMETRY"
  | "POINT_LIMIT_EXCEEDED"
  | "TELEPORT_JUMP"
  | "TINY_TRACK"
  | "EXTREME_LENGTH"
  | "CORRUPT_ELEVATION"
  | "SUMMIT_MISS"
  | "AMBIGUOUS_SUMMIT"
  | "HIGH_MOUNTAIN_START"
  | "ROAD_OR_MOTORWAY_RISK"
  | "DUPLICATE_ROUTE"
  | "NON_HIKING_ACTIVITY"
  | "PRIVACY_REVIEW_REQUIRED";

export type Coordinate =
  | readonly [longitude: number, latitude: number]
  | readonly [longitude: number, latitude: number, elevationM: number];

export interface ParsedGpxPoint {
  coordinate: Coordinate;
  time: string | null;
}

export interface ParsedGpxSegment {
  points: ParsedGpxPoint[];
}

export type GpxNormalizationFlag =
  | "MISSING_ELEVATION"
  | "PARTIAL_ELEVATION"
  | "MISSING_TIMESTAMPS"
  | "PARTIAL_TIMESTAMPS"
  | "MALFORMED_TIMESTAMP_DROPPED"
  | "NON_MONOTONIC_TIME_RANGE"
  | "MULTIPLE_TRACKS";

export interface TrackBoundingBox {
  minimumLongitude: number;
  minimumLatitude: number;
  maximumLongitude: number;
  maximumLatitude: number;
}

export type NormalizedTrackGeometry =
  | { type: "LineString"; coordinates: Coordinate[] }
  | { type: "MultiLineString"; coordinates: Coordinate[][] };

export interface NormalizedGpxGeometry {
  geometry: NormalizedTrackGeometry;
  normalizedGeometryHash: string;
  directionNeutralGeometryHash: string;
  distanceM: number;
  minimumElevationM: number | null;
  maximumElevationM: number | null;
  elevationGainM: number | null;
  pointCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  boundingBox: TrackBoundingBox;
  startCoordinate: Coordinate;
  endCoordinate: Coordinate;
}

export interface NormalizedServerGpx {
  schemaVersion: "mountain-tracker/external-gpx/v1";
  normalizationVersion: "mountain-tracker/gpx-normalization/v1";
  elevationAlgorithmVersion: "positive-delta-3m/v1";
  rawContentHash: string;
  normalizedGeometryHash: string;
  directionNeutralGeometryHash: string;
  geometry: NormalizedTrackGeometry;
  pointCount: number;
  segmentCount: number;
  distanceM: number;
  elevationGainM: number | null;
  minimumElevationM: number | null;
  maximumElevationM: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  startCoordinate: Coordinate;
  endCoordinate: Coordinate;
  boundingBox: TrackBoundingBox;
  displayMetadata: {
    name: string | null;
  };
  normalizationFlags: GpxNormalizationFlag[];
}

export interface NormalizedGpxMetadata {
  name: string | null;
  description: string | null;
  activityType: string | null;
  routeType: string | null;
  difficultySystem: string | null;
  difficultyValue: string | null;
  bestSeason: string | null;
  equipment: string | null;
  warnings: string | null;
  attribution: string | null;
  sourceUrl: string | null;
}

export interface NormalizedSourceTrack {
  sourceKey: string;
  sourceSnapshotKey: string;
  sourceNativeId: string;
  sourceRecordHash: string;
  recordIdempotencyKey: string;
  metadata: NormalizedGpxMetadata;
  geometry: NormalizedGpxGeometry;
  rawContentHash: string;
  processingState: TrackProcessingState;
  qualityStatus: QualityStatus;
  publicationStatus: PublicationStatus;
}

export interface SourceRightsPolicy {
  licenseStatus: SourcePolicyStatus;
  accessPermissionStatus: SourcePolicyStatus;
  redistributionPermissionStatus: SourcePolicyStatus;
  rawGpxRetentionPermission: SourcePolicyStatus;
  normalizedGeometryPublicationPermission: SourcePolicyStatus;
  attributionRequired: boolean;
  attributionText: string | null;
  lastVerifiedAt: string | null;
}

export interface SourceDiscoveryRecord {
  sourceNativeId: string;
  sourceUrl: string;
  metadataHint: Readonly<Record<string, unknown>>;
}

export interface SourceTrackMetadata {
  sourceNativeId: string;
  sourceUrl: string;
  downloadUrl: string | null;
  metadata: Readonly<Record<string, unknown>>;
}

export interface FetchedSourceTrack {
  sourceNativeId: string;
  sourceUrl: string;
  bytes: Uint8Array;
  retrievedAt: string;
  responseMetadata: Readonly<Record<string, string>>;
}
