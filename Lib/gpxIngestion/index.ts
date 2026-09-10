// Phase 12A/12B/12C public surface of the ingestion and independent OSM
// reconstruction domain.
//
// Export the pure, server-safe building blocks. No browser globals, no DB
// access, no publication here — those are the responsibilities of later Phase
// 12 sub-phases (adapter executors, staging controller, promotion).

export * from "./types.ts";
export {
  classifyLicense,
  evaluateSourcePolicy,
  isPromotable,
  type LicenseClassification,
  type SourcePolicyEvaluation,
} from "./license.ts";
export {
  GEOMETRY_HASH_CONTRACT_VERSION,
  sha256Stable,
  sha256Bytes,
  sha256GeometryHash,
  sha256DirectionNeutralGeometryHash,
  stableJson,
} from "./hashing.ts";
export {
  sanitizeMetadata,
  METADATA_FIELD_LIMITS,
} from "./metadataSanitization.ts";
export {
  buildRecordIdentity,
  normalizeSourceKey,
  normalizeSourceNativeId,
  type RecordIdentity,
  type RecordIdentityInput,
} from "./sourceIdentity.ts";
export {
  canTransitionRun,
  canTransitionTrack,
  transitionRun,
  transitionTrack,
  VALID_RUN_STATES,
  VALID_TRACK_STATES,
} from "./stateMachine.ts";
export {
  normalizeGpxGeometry,
  normalizeGpxSegments,
  normalizeServerGpx,
  GpxGeometryTooShortError,
  GpxNormalizationError,
  calculateCoordinateDistanceMeters,
  ELEVATION_GAIN_JITTER_THRESHOLD_M,
  GPX_NORMALIZED_SCHEMA_VERSION,
  GPX_NORMALIZATION_VERSION,
  GPX_ELEVATION_ALGORITHM_VERSION,
  DEFAULT_NORMALIZE_GEOMETRY_OPTIONS,
  type NormalizeGeometryOptions,
  type NormalizeResult,
} from "./gpxNormalization.ts";
export {
  DEFAULT_SERVER_GPX_LIMITS,
  ServerGpxError,
  validateServerGpxParserLimits,
  type ServerGpxErrorCode,
  type ServerGpxParser,
  type ServerGpxParserLimits,
  type ServerParsedGpx,
} from "./parserContract.ts";
export {
  SaxServerGpxParser,
  parseAndNormalizeServerGpx,
  SERVER_GPX_PARSER_NAME,
  SERVER_GPX_PARSER_VERSION,
} from "./serverGpxParser.ts";
export {
  planMountainMatch,
  matchResolvedPeaks,
  DEFAULT_MATCH_THRESHOLDS,
  type MountainMatchPlan,
  type MountainMatchCandidate,
  type MountainMatchResult,
  type MountainCandidateIndex,
  type MountainMatchThresholds,
  type MatchableMountain,
} from "./mountainMatching.ts";
export {
  assertAdapterMayRun,
  defaultNormalizeSourceIdentity,
  normalizeDescriptor,
  validateSourceAdapterDescriptor,
  type GpxSourceAdapter,
  type SourceAdapterDescriptor,
} from "./sourceAdapter.ts";
export {
  fetchBoundedHttps,
  isPublicIpAddress,
  SourceHttpError,
  validateSourceUrl,
  type BoundedHttpResponse,
  type SourceFetch,
  type SourceHostResolver,
  type SourceHttpDependencies,
  type SourceHttpErrorCode,
  type SourceHttpPolicy,
} from "./hardenedSourceHttp.ts";
export * from "./osmPublicGpxRegistry.ts";
export {
  canonicalOsmNativeId,
  canonicalOsmTraceDownloadUrl,
  canonicalOsmTraceUrl,
  evaluateOsmTracePolicy,
  executeWithRetry,
  ingestOsmTrace,
  normalizeFetchedOsmTrace,
  normalizeOsmTraceNativeId,
  OpenStreetMapPublicGpxAdapter,
  OsmSourceError,
  parseOsmTraceId,
  type IngestOsmTraceOptions,
  type OsmAdapterOptions,
  type OsmNormalizedSourceTrack,
  type OsmSourceErrorCode,
  type OsmTraceMetadata,
  type OsmTracePolicyEvaluation,
  type OsmTracePolicyStatus,
} from "./osmPublicGpxAdapter.ts";
export * from "./routeDiscovery.ts";
export * from "./osmAnchorResolution.ts";
export * from "./semanticFeatureIndex.ts";
export * from "./semanticEntityResolution.ts";
export * from "./routableAnchorResolution.ts";
export * from "./nameNormalization.ts";
export * from "./osmTrailGraph.ts";
export * from "./osmRouteReconstruction.ts";
