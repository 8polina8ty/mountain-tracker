/** Shared contracts for the deterministic Route Factory pipeline. */

export const ROUTE_FACTORY_SCHEMA_VERSION = 'mountain-tracker/route-factory/v1' as const;
export const ROUTE_FACTORY_ALGORITHM_VERSION = 'mountain-tracker/route-factory-algorithm/v1' as const;
export const BASE_ACCESS_POLICY_VERSION = 'mountain-tracker/base-access-start-policy/v2' as const;
export const CLUSTER_REVISION = 'mountain-tracker/cluster-revision/v1' as const;

export const CANDIDATE_STATE = {
  AUTO_APPROVED: 'AUTO_APPROVED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
} as const;
export type CandidateState = (typeof CANDIDATE_STATE)[keyof typeof CANDIDATE_STATE];

export const REVIEW_WARNING = {
  DISTANCE_EXTREME: 'DISTANCE_EXTREME',
  DETOUR_RATIO_HIGH: 'DETOUR_RATIO_HIGH',
  START_ELEVATION_UNKNOWN: 'START_ELEVATION_UNKNOWN',
  SERVICE_TRACK_DEPENDENCE: 'SERVICE_TRACK_DEPENDENCE',
  DIFFERENT_UPPER_APPROACH: 'DIFFERENT_UPPER_APPROACH',
  LOW_REFERENCE_ROUTE_OVERLAP: 'LOW_REFERENCE_ROUTE_OVERLAP',
  PUBLIC_ACCESS_NOT_CUSTOMARY_UNVERIFIED: 'PUBLIC_ACCESS_NOT_CUSTOMARY_UNVERIFIED',
} as const;
export type ReviewWarning = (typeof REVIEW_WARNING)[keyof typeof REVIEW_WARNING];

export const REVIEW_DECISION = {
  APPROVE: 'APPROVE',
  REGENERATE: 'REGENERATE',
  REJECT: 'REJECT',
} as const;
export type ReviewDecision = (typeof REVIEW_DECISION)[keyof typeof REVIEW_DECISION];

export interface Coordinate { readonly latitude: number; readonly longitude: number; }

export interface CandidateResult {
  readonly candidateId: string;
  readonly state: CandidateState;
  readonly warnings: readonly ReviewWarning[];
  readonly gateFailures: readonly string[];
  readonly distanceKm: number | null;
  readonly primaryBaseAccess: boolean;
  readonly routeAvailable: boolean;
  readonly reasons: readonly string[];
}

export interface RouteEntry {
  readonly mountainId: number;
  readonly name: string;
  readonly state: CandidateState;
  readonly resultHash: string | null;
  readonly graphStatus: string;
  readonly status: string;
  readonly starters: readonly CandidateResult[];
  readonly warnings: readonly ReviewWarning[];
  readonly gateFailures: readonly string[];
}

export interface RunManifest {
  readonly schemaVersion: typeof ROUTE_FACTORY_SCHEMA_VERSION;
  readonly runId: string;
  readonly startedAt: string;
  readonly parameters: Readonly<{
    limit: number;
    datasetKey: string;
    region: string;
    algorithmVersion: typeof ROUTE_FACTORY_ALGORITHM_VERSION;
    baseAccessPolicyVersion: typeof BASE_ACCESS_POLICY_VERSION;
  }>;
  readonly inputFingerprint: string;
  readonly mountainSelection: ReadonlyArray<number>;
  readonly policyVersions: Readonly<{ algorithm: typeof ROUTE_FACTORY_ALGORITHM_VERSION; baseAccess: typeof BASE_ACCESS_POLICY_VERSION }>;
  readonly codeVersion?: string;
  readonly summary: Readonly<{
    total: number;
    processed: number;
    autoApproved: number;
    needsReview: number;
    rejected: number;
    failed: number;
  }>;
  readonly manifestHash: string;
}

export interface RunState {
  readonly state: 'RUNNING' | 'COMPLETED';
  readonly lastIndex: number;
  readonly counts: Readonly<{ AUTO_APPROVED: number; NEEDS_REVIEW: number; REJECTED: number; FAILED: number }>;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface PublicationEntry {
  readonly mountainId: number;
  readonly publicationId: string;
  readonly requestHash: string;
  readonly storagePath: string;
  readonly gpxSha256: string;
  readonly geojsonSha256: string;
  readonly gpxBytes: number;
  readonly geojsonBytes: number;
  readonly distanceKm: number;
}

export interface ReviewDecisionRecord {
  readonly mountainId: number;
  readonly candidateIds: readonly string[];
  readonly decision: ReviewDecision;
  readonly decidedAt: string;
  readonly reviewer: string;
  readonly note?: string;
}

/** Re-export the canonical deterministic hashing singleton for factory fingerprints. */
export { sha256Stable as hashFingerprint } from '../../Lib/gpxIngestion/hashing.ts';