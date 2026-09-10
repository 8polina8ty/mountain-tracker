// Phase 12C route-existence signals. These contracts deliberately contain
// semantic facts only; source geometry belongs to a separately reviewed
// capability and never enters RouteDiscoverySignal.

export const ROUTE_DISCOVERY_SIGNAL_SCHEMA_VERSION =
  "mountain-tracker/route-discovery-signal/v1" as const;

export const ROUTE_DISCOVERY_LIMITS = {
  maximumSignalBytes: 16_384,
  maximumViaHints: 8,
  maximumNameCharacters: 160,
  maximumReferenceCharacters: 300,
} as const;

export type DiscoveryCapability =
  | "DISCOVERY_NAME_ONLY"
  | "DISCOVERY_SEMANTIC_ANCHORS";

export type GeometryCapability = "GEOMETRY_ALLOWED" | "RAW_GPX_ALLOWED";

export type SourceCapabilityStatus =
  | "ALLOWED"
  | "REVIEW_REQUIRED"
  | "BLOCKED"
  | "REQUIRES_PROVIDER_PERMISSION";

export interface DiscoverySourcePolicy {
  sourceKey: string;
  sourceName: string;
  provider: string;
  discoveryCapability: DiscoveryCapability;
  discoveryStatus: SourceCapabilityStatus;
  geometryCapabilities: GeometryCapability[];
  geometryStatus: SourceCapabilityStatus;
  automatedNetworkAccess: SourceCapabilityStatus;
  geometryLicense: string | null;
  policyVersion: string;
  notes: string;
}

export const DISCOVERY_SOURCE_POLICIES = {
  wikiloc: {
    sourceKey: "wikiloc",
    sourceName: "Wikiloc",
    provider: "Wikiloc Outdoor Navigation S.L.",
    discoveryCapability: "DISCOVERY_SEMANTIC_ANCHORS",
    discoveryStatus: "REQUIRES_PROVIDER_PERMISSION",
    geometryCapabilities: [],
    geometryStatus: "BLOCKED",
    automatedNetworkAccess: "REQUIRES_PROVIDER_PERMISSION",
    geometryLicense: null,
    policyVersion: "phase12c/discovery-policy/v1",
    notes: "No automated access or geometry reuse without explicit provider permission.",
  },
  komoot: {
    sourceKey: "komoot",
    sourceName: "Komoot",
    provider: "komoot GmbH",
    discoveryCapability: "DISCOVERY_SEMANTIC_ANCHORS",
    discoveryStatus: "REQUIRES_PROVIDER_PERMISSION",
    geometryCapabilities: [],
    geometryStatus: "BLOCKED",
    automatedNetworkAccess: "REQUIRES_PROVIDER_PERMISSION",
    geometryLicense: null,
    policyVersion: "phase12c/discovery-policy/v1",
    notes: "No automated access or geometry reuse without explicit provider permission.",
  },
  hikr: {
    sourceKey: "hikr",
    sourceName: "HIKR",
    provider: "HIKR",
    discoveryCapability: "DISCOVERY_NAME_ONLY",
    discoveryStatus: "REVIEW_REQUIRED",
    geometryCapabilities: [],
    geometryStatus: "BLOCKED",
    automatedNetworkAccess: "REVIEW_REQUIRED",
    geometryLicense: null,
    policyVersion: "phase12c/discovery-policy/v1",
    notes: "Authoritative automated-use and licensing permission has not been established.",
  },
  openstreetmap: {
    sourceKey: "openstreetmap",
    sourceName: "OpenStreetMap",
    provider: "OpenStreetMap contributors",
    discoveryCapability: "DISCOVERY_SEMANTIC_ANCHORS",
    discoveryStatus: "ALLOWED",
    geometryCapabilities: ["GEOMETRY_ALLOWED"],
    geometryStatus: "ALLOWED",
    automatedNetworkAccess: "BLOCKED",
    geometryLicense: "ODbL-1.0",
    policyVersion: "phase12c/discovery-policy/v1",
    notes: "Geometry must come from the frozen local OSM dataset; public per-route API queries are not used.",
  },
  "manual-research": {
    sourceKey: "manual-research",
    sourceName: "Manual reviewed research",
    provider: "Mountain Tracker",
    discoveryCapability: "DISCOVERY_SEMANTIC_ANCHORS",
    discoveryStatus: "ALLOWED",
    geometryCapabilities: [],
    geometryStatus: "BLOCKED",
    automatedNetworkAccess: "BLOCKED",
    geometryLicense: null,
    policyVersion: "phase12c/discovery-policy/v1",
    notes: "Versioned semantic facts only; no copied third-party route geometry.",
  },
} as const satisfies Record<string, DiscoverySourcePolicy>;

export type DiscoverySourceKey = keyof typeof DISCOVERY_SOURCE_POLICIES;

export type RouteShapeHint =
  | "ONE_WAY"
  | "OUT_AND_BACK"
  | "LOOP"
  | "TRAVERSE"
  | "UNKNOWN";

export type DiscoveryActivityType =
  | "HIKING"
  | "WALKING"
  | "MOUNTAINEERING"
  | "UNKNOWN";

export type SemanticAnchorType =
  | "TRAILHEAD"
  | "PARKING"
  | "SETTLEMENT"
  | "HUT"
  | "PASS"
  | "SADDLE"
  | "VALLEY"
  | "JUNCTION"
  | "SUMMIT"
  | "OTHER_NAMED_FEATURE";

export interface SemanticAnchorHint {
  name: string;
  expectedTypes: SemanticAnchorType[];
  regionName: string | null;
}

export interface DiscoveryMountainIdentity {
  name: string;
  regionName: string | null;
  countryCode: string | null;
}

export interface RouteDiscoverySignal {
  schemaVersion: typeof ROUTE_DISCOVERY_SIGNAL_SCHEMA_VERSION;
  signalId: string;
  sourceKey: DiscoverySourceKey;
  sourceReference: string;
  observedAt: string;
  mountainIdentity: DiscoveryMountainIdentity;
  routeVariantName: string | null;
  activityType: DiscoveryActivityType;
  startHint: SemanticAnchorHint;
  viaHints: SemanticAnchorHint[];
  summitHint: SemanticAnchorHint;
  terminalHint: SemanticAnchorHint | null;
  routeShapeHint: RouteShapeHint;
  directionHint: string | null;
  sourcePolicyStatus: SourceCapabilityStatus;
  signalConfidence: number;
  discoveryProvenance: {
    sourceKey: DiscoverySourceKey;
    sourceReference: string;
    role: "ROUTE_EXISTENCE_SIGNAL";
  };
}

export interface DiscoveryRequest {
  cursor: string | null;
  limit: number;
  signal: AbortSignal;
}

export interface DiscoverySignalPage {
  signals: RouteDiscoverySignal[];
  nextCursor: string | null;
}

export interface RouteDiscoverySourceAdapter {
  readonly policy: DiscoverySourcePolicy;
  discover(request: DiscoveryRequest): Promise<DiscoverySignalPage>;
}

const TOP_LEVEL_KEYS = new Set([
  "signalId",
  "sourceKey",
  "sourceReference",
  "observedAt",
  "mountainIdentity",
  "routeVariantName",
  "activityType",
  "startHint",
  "viaHints",
  "summitHint",
  "terminalHint",
  "routeShapeHint",
  "directionHint",
  "sourcePolicyStatus",
  "signalConfidence",
]);

const PROHIBITED_GEOMETRY_KEYS = new Set([
  "gpx",
  "fullgpx",
  "geojson",
  "geometry",
  "routegeometry",
  "polyline",
  "encodedpolyline",
  "trackpoint",
  "trackpoints",
  "coordinates",
  "coordinate",
  "geometryhash",
]);

const ANCHOR_TYPES = new Set<SemanticAnchorType>([
  "TRAILHEAD",
  "PARKING",
  "SETTLEMENT",
  "HUT",
  "PASS",
  "SADDLE",
  "VALLEY",
  "JUNCTION",
  "SUMMIT",
  "OTHER_NAMED_FEATURE",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replaceAll(/[_-]/g, "");
}

function rejectGeometry(value: unknown, path = "signal", depth = 0): void {
  if (depth > 12) throw new Error("Discovery signal nesting is too deep.");
  if (Array.isArray(value)) {
    if (
      value.length >= 2 &&
      value.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length >= 2 &&
          entry.slice(0, 2).every((part) => typeof part === "number"),
      )
    ) {
      throw new Error(`${path} contains a prohibited coordinate sequence.`);
    }
    value.forEach((entry, index) => rejectGeometry(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (PROHIBITED_GEOMETRY_KEYS.has(normalizedKey(key))) {
      throw new Error(`${path}.${key} is prohibited in a discovery signal.`);
    }
    rejectGeometry(entry, `${path}.${key}`, depth + 1);
  }
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const normalized = value.normalize("NFKC").replaceAll(/\s+/g, " ").trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${field} must contain 1-${maximum} characters.`);
  }
  if (/[<>\u0000-\u001f\u007f]/u.test(normalized) || /javascript:/i.test(normalized)) {
    throw new Error(`${field} contains unsafe markup or control characters.`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  return value === null || value === undefined
    ? null
    : boundedText(value, field, maximum);
}

function semanticHint(value: unknown, field: string): SemanticAnchorHint {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!["name", "expectedTypes", "regionName"].includes(key)) {
      throw new Error(`${field}.${key} is not a semantic-anchor field.`);
    }
  }
  const expectedTypes = value.expectedTypes ?? [];
  if (!Array.isArray(expectedTypes) || expectedTypes.length > 4) {
    throw new Error(`${field}.expectedTypes must contain at most four values.`);
  }
  const normalizedTypes = expectedTypes.map((entry) => {
    if (typeof entry !== "string" || !ANCHOR_TYPES.has(entry as SemanticAnchorType)) {
      throw new Error(`${field}.expectedTypes contains an invalid anchor type.`);
    }
    return entry as SemanticAnchorType;
  });
  return {
    name: boundedText(value.name, `${field}.name`, ROUTE_DISCOVERY_LIMITS.maximumNameCharacters),
    expectedTypes: [...new Set(normalizedTypes)].sort(),
    regionName: optionalText(
      value.regionName,
      `${field}.regionName`,
      ROUTE_DISCOVERY_LIMITS.maximumNameCharacters,
    ),
  };
}

function validIsoTimestamp(value: unknown): string {
  const timestamp = boundedText(value, "observedAt", 40);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error("observedAt must be a canonical ISO-8601 UTC timestamp.");
  }
  return timestamp;
}

function sourcePolicy(sourceKey: string): DiscoverySourcePolicy {
  const policy = DISCOVERY_SOURCE_POLICIES[sourceKey as DiscoverySourceKey];
  if (!policy) throw new Error(`Unknown discovery source: ${sourceKey}.`);
  return policy;
}

export function assertProviderMaySupplyDiscovery(policy: DiscoverySourcePolicy): void {
  if (policy.discoveryStatus !== "ALLOWED") {
    throw new Error(
      `${policy.sourceKey} discovery is ${policy.discoveryStatus}; automatic signal ingestion is not allowed.`,
    );
  }
}

export function createRouteDiscoverySignal(input: unknown): RouteDiscoverySignal {
  rejectGeometry(input);
  if (!isRecord(input)) throw new Error("Discovery signal must be an object.");
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new Error(`Unknown discovery signal field: ${key}.`);
  }
  const encodedSize = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (encodedSize > ROUTE_DISCOVERY_LIMITS.maximumSignalBytes) {
    throw new Error("Discovery signal exceeds its byte limit.");
  }

  const sourceKey = boundedText(input.sourceKey, "sourceKey", 80);
  const policy = sourcePolicy(sourceKey);
  assertProviderMaySupplyDiscovery(policy);
  if (input.sourcePolicyStatus !== policy.discoveryStatus) {
    throw new Error("sourcePolicyStatus does not match the versioned provider policy.");
  }
  const signalId = boundedText(input.signalId, "signalId", 128);
  if (!/^[a-z0-9][a-z0-9:_-]*$/.test(signalId)) {
    throw new Error("signalId must be a stable lowercase identifier without paths.");
  }
  const sourceReference = boundedText(
    input.sourceReference,
    "sourceReference",
    ROUTE_DISCOVERY_LIMITS.maximumReferenceCharacters,
  );
  if (/(^|[\\/])\.\.([\\/]|$)/.test(sourceReference)) {
    throw new Error("sourceReference must not contain path traversal.");
  }
  if (!isRecord(input.mountainIdentity)) {
    throw new Error("mountainIdentity must be an object.");
  }
  for (const key of Object.keys(input.mountainIdentity)) {
    if (!["name", "regionName", "countryCode"].includes(key)) {
      throw new Error(`mountainIdentity.${key} is not allowed.`);
    }
  }
  const countryCode = optionalText(input.mountainIdentity.countryCode, "countryCode", 2);
  if (countryCode !== null && !/^[A-Z]{2}$/.test(countryCode)) {
    throw new Error("countryCode must be an uppercase ISO alpha-2 code.");
  }
  const viaInput = input.viaHints ?? [];
  if (!Array.isArray(viaInput) || viaInput.length > ROUTE_DISCOVERY_LIMITS.maximumViaHints) {
    throw new Error(`viaHints must contain at most ${ROUTE_DISCOVERY_LIMITS.maximumViaHints} entries.`);
  }
  const activityTypes = new Set<DiscoveryActivityType>([
    "HIKING",
    "WALKING",
    "MOUNTAINEERING",
    "UNKNOWN",
  ]);
  const routeShapes = new Set<RouteShapeHint>([
    "ONE_WAY",
    "OUT_AND_BACK",
    "LOOP",
    "TRAVERSE",
    "UNKNOWN",
  ]);
  if (!activityTypes.has(input.activityType as DiscoveryActivityType)) {
    throw new Error("activityType is invalid.");
  }
  if (!routeShapes.has(input.routeShapeHint as RouteShapeHint)) {
    throw new Error("routeShapeHint is invalid.");
  }
  if (
    typeof input.signalConfidence !== "number" ||
    !Number.isFinite(input.signalConfidence) ||
    input.signalConfidence < 0 ||
    input.signalConfidence > 1
  ) {
    throw new Error("signalConfidence must be between zero and one.");
  }

  const signal: RouteDiscoverySignal = {
    schemaVersion: ROUTE_DISCOVERY_SIGNAL_SCHEMA_VERSION,
    signalId,
    sourceKey: sourceKey as DiscoverySourceKey,
    sourceReference,
    observedAt: validIsoTimestamp(input.observedAt),
    mountainIdentity: {
      name: boundedText(
        input.mountainIdentity.name,
        "mountainIdentity.name",
        ROUTE_DISCOVERY_LIMITS.maximumNameCharacters,
      ),
      regionName: optionalText(
        input.mountainIdentity.regionName,
        "mountainIdentity.regionName",
        ROUTE_DISCOVERY_LIMITS.maximumNameCharacters,
      ),
      countryCode,
    },
    routeVariantName: optionalText(
      input.routeVariantName,
      "routeVariantName",
      ROUTE_DISCOVERY_LIMITS.maximumNameCharacters,
    ),
    activityType: input.activityType as DiscoveryActivityType,
    startHint: semanticHint(input.startHint, "startHint"),
    viaHints: viaInput.map((entry, index) => semanticHint(entry, `viaHints[${index}]`)),
    summitHint: semanticHint(input.summitHint, "summitHint"),
    terminalHint:
      input.terminalHint === null || input.terminalHint === undefined
        ? null
        : semanticHint(input.terminalHint, "terminalHint"),
    routeShapeHint: input.routeShapeHint as RouteShapeHint,
    directionHint: optionalText(input.directionHint, "directionHint", 120),
    sourcePolicyStatus: policy.discoveryStatus,
    signalConfidence: input.signalConfidence,
    discoveryProvenance: {
      sourceKey: sourceKey as DiscoverySourceKey,
      sourceReference,
      role: "ROUTE_EXISTENCE_SIGNAL",
    },
  };
  return signal;
}

export function validateDiscoveryAdapter(adapter: RouteDiscoverySourceAdapter): void {
  const registered = sourcePolicy(adapter.policy.sourceKey);
  if (registered.policyVersion !== adapter.policy.policyVersion) {
    throw new Error("Discovery adapter policy does not match the registry.");
  }
  assertProviderMaySupplyDiscovery(registered);
}
