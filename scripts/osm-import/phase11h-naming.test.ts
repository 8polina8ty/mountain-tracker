import assert from "node:assert/strict";
import test from "node:test";

import { sha256Stable } from "./phase11-publication.ts";
import type { Phase11gQualificationInput } from "./phase11g-qualification.ts";
import { qualifyPhase11gRoute } from "./phase11g-qualification.ts";
import type { NearbyFeature, StartContextOptions } from "./start-context-classifier3.ts";
import {
  PHASE11H_DERIVED_AMBIGUITY_WINDOW_METERS,
  classifyRouteRef,
  composeDerivedDisplayName,
  deriveNamedStartEntity,
  isNameReady,
  normalizeNameForCompare,
  qualityBand,
  resolvePhase11hNameResolution,
  type Phase11hNamedStartEntity,
} from "./phase11h-naming.ts";

const options: StartContextOptions = {
  hutProximityThresholdMeters: 200,
  highMountainProximityThresholdMeters: 500,
  parkingThresholdMeters: 300,
  trailheadThresholdMeters: 300,
  trailheadInfoThresholdMeters: 100,
  settlementThresholdMeters: 1000,
  settlementTightThresholdMeters: 300,
  transitThresholdMeters: 150,
  dwellingThresholdMeters: 600,
  dwellingTightThresholdMeters: 100,
  eleNodeRadiusMeters: 300,
  minVerticalGainForBaseStartMeters: 500,
};

function feature(overrides: Partial<NearbyFeature> = {}): NearbyFeature {
  return {
    featureType: "alpine_hut",
    osmid: "1",
    objectType: "node",
    name: "Hut Name",
    coordinate: [10, 46],
    distanceMeters: 100,
    tags: {},
    ...overrides,
  };
}

function summit(overrides: Partial<NonNullable<Parameters<typeof resolvePhase11hNameResolution>[0]["summitEntity"]>> = {}) {
  return {
    peakSourceId: "peak-1",
    peakName: "Monte Test",
    peakElevationMeters: 2500,
    ...overrides,
  };
}

function resolve(input: {
  rawTags?: Record<string, string>;
  startContext?: string | null;
  startEntity?: Phase11hNamedStartEntity | null;
  summitEntity?: { peakSourceId: string; peakName: string | null; peakElevationMeters: number | null } | null;
}) {
  return resolvePhase11hNameResolution({
    canonicalRelationId: "1",
    rawTags: input.rawTags ?? {},
    startContext: input.startContext ?? null,
    startEntity: input.startEntity ?? null,
    summitEntity: input.summitEntity === undefined ? summit() : input.summitEntity,
  });
}

test("11H: relation name tag is preferred (SOURCE_NAME)", () => {
  const resolution = resolve({ rawTags: { name: "Höllensteig" } });
  assert.equal(resolution.nameStatus, "SOURCE_NAME");
  assert.equal(resolution.nameOrigin, "RELATION_NAME");
  assert.equal(isNameReady(resolution.nameStatus), true);
  assert.equal(resolution.derivedDisplayName, null);
});

test("11H: official_name is the fallback when name is absent", () => {
  const resolution = resolve({ rawTags: { official_name: "Sentiero Ufficiale" } });
  assert.equal(resolution.nameStatus, "SOURCE_OFFICIAL_NAME");
  assert.equal(resolution.nameOrigin, "RELATION_OFFICIAL_NAME");
  assert.equal(isNameReady(resolution.nameStatus), true);
});

test("11H: local_name is the fallback when name and official_name are absent", () => {
  const resolution = resolve({ rawTags: { local_name: "Lokaler Name" } });
  assert.equal(resolution.nameStatus, "SOURCE_LOCAL_NAME");
  assert.equal(resolution.nameOrigin, "RELATION_LOCAL_NAME");
  assert.equal(isNameReady(resolution.nameStatus), true);
});

test("11H: ref never silently becomes an invented route name (REF_ONLY)", () => {
  const resolution = resolve({
    rawTags: { ref: "149" },
    startEntity: null,
    summitEntity: null,
  });
  assert.equal(resolution.nameStatus, "REF_ONLY");
  assert.equal(resolution.nameOrigin, "ROUTE_REF_ONLY");
  assert.equal(resolution.derivedDisplayName, null);
  assert.equal(resolution.sourceNamePreservedAsNull, true);
  assert.equal(isNameReady(resolution.nameStatus), false);
});

test("11H: HUT exact-name start + exact summit can derive a label", () => {
  const startEntity = deriveNamedStartEntity({
    startContext: "HUT_START",
    nearbyFeatures: [feature({ featureType: "alpine_hut", name: "Rifugio Perugia" })],
    options,
  });
  assert.ok(startEntity);
  const resolution = resolve({ startContext: "HUT_START", startEntity });
  assert.equal(resolution.nameStatus, "DERIVED_SOURCE_BACKED");
  assert.equal(resolution.derivedDisplayName, "Rifugio Perugia – Monte Test");
  assert.equal(resolution.nameOrigin, "DERIVED_FROM_FROZEN_OSM");
  assert.equal(resolution.sourceName, null);
  assert.equal(resolution.sourceNamePreservedAsNull, true);
});

test("11H: BASE exact named start + exact summit can derive a label", () => {
  const startEntity = deriveNamedStartEntity({
    startContext: "BASE_START",
    nearbyFeatures: [
      feature({ featureType: "trailhead_info", name: "Val Bona", distanceMeters: 40 }),
    ],
    options,
  });
  assert.ok(startEntity);
  const resolution = resolve({ startContext: "BASE_START", startEntity });
  assert.equal(resolution.nameStatus, "DERIVED_SOURCE_BACKED");
  assert.equal(resolution.derivedDisplayName, "Val Bona – Monte Test");
});

test("11H: fuzzy/nearby settlement cannot derive a label (beyond tight window)", () => {
  const startEntity = deriveNamedStartEntity({
    startContext: "BASE_START",
    nearbyFeatures: [
      feature({ featureType: "village", name: "Bad Kleinkirchheim", distanceMeters: 800 }),
    ],
    options,
  });
  assert.equal(startEntity, null);
  const resolution = resolve({ startContext: "BASE_START", startEntity: null });
  assert.equal(resolution.nameStatus, "UNRESOLVED");
  assert.equal(resolution.derivedDisplayName, null);
});

test("11H: unnamed parking cannot generate a fake name", () => {
  const startEntity = deriveNamedStartEntity({
    startContext: "BASE_START",
    nearbyFeatures: [feature({ featureType: "parking", name: null, distanceMeters: 50 })],
    options,
  });
  assert.equal(startEntity, null);
  const resolution = resolve({ startContext: "BASE_START", startEntity: null });
  assert.equal(resolution.nameStatus, "UNRESOLVED");
  assert.equal(resolution.derivedDisplayName, null);
});

test("11H: multiple possible named starts within ambiguity window stay unresolved", () => {
  const startEntity = deriveNamedStartEntity({
    startContext: "HUT_START",
    nearbyFeatures: [
      feature({ featureType: "alpine_hut", name: "Hütte A", osmid: "2", distanceMeters: 100 }),
      feature({ featureType: "alpine_hut", name: "Hütte B", osmid: "3", distanceMeters: 140 }),
    ],
    options,
  });
  assert.equal(startEntity, null);
});

test("11H: a single unambiguous named start within the window is selected", () => {
  const startEntity = deriveNamedStartEntity({
    startContext: "HUT_START",
    nearbyFeatures: [
      feature({ featureType: "alpine_hut", name: "Hütte A", osmid: "2", distanceMeters: 100 }),
      feature({ featureType: "wilderness_hut", name: "Hütte B", osmid: "3", distanceMeters: 500 }),
    ],
    options,
  });
  assert.ok(startEntity);
  assert.equal(startEntity.name, "Hütte A");
  assert.equal(startEntity.osmid, "2");
});

test("11H: exact summit is required for a derived label", () => {
  const startEntity = deriveNamedStartEntity({
    startContext: "HUT_START",
    nearbyFeatures: [feature({ featureType: "alpine_hut", name: "Rifugio" })],
    options,
  });
  const resolution = resolve({ startContext: "HUT_START", startEntity, summitEntity: null });
  assert.equal(resolution.nameStatus, "UNRESOLVED");
  assert.equal(resolution.derivedDisplayName, null);
});

test("11H: derived name preserves sourceName null and records origin", () => {
  const startEntity = deriveNamedStartEntity({
    startContext: "HUT_START",
    nearbyFeatures: [feature({ featureType: "alpine_hut", name: "Rifugio Perugia" })],
    options,
  });
  const resolution = resolve({ startContext: "HUT_START", startEntity });
  assert.equal(resolution.sourceName, null);
  assert.equal(resolution.nameOrigin, "DERIVED_FROM_FROZEN_OSM");
  assert.equal(resolution.sourceNamePreservedAsNull, true);
  assert.ok(resolution.nameEvidence.some((line) => line.includes("Derived label")));
});

test("11H: machine GREEN remains GREEN when the name is unresolved (presentation only)", () => {
  const qualification = qualifyPhase11gRoute({
    canonicalRouteSourceId: "route-1",
    sourceUrl: "https://www.openstreetmap.org/relation/1",
    routeName: null,
    semanticType: "summit_route",
    routeType: "hiking",
    activityManualReviewRequired: false,
    geometryValid: true,
    qualityScore: 95,
    auditFlags: ["MISSING_NAME"],
    warnings: [],
    summits: [{ peakOsmId: "peak-1", finalAssociation: "CONFIRMED", endpointDistanceMeters: 2 }],
    topologyClassification: "SIMPLE",
    connectedGroupCount: 1,
    physicalEndpointCount: 2,
    endpointSelectionAmbiguous: false,
    explicitlySupportedClosedLoop: false,
    active: false,
    duplicateRelationIdentity: false,
    duplicateSourceUrl: false,
    publicationSourceConflict: false,
    dataIntegrityFailure: false,
    routeMemberDataIntegrityFailure: false,
    roadSafetyStatus: "SAFE",
    roadSafetyReasonCodes: [],
    startContext: "BASE_START",
    startElevationMeters: 800,
    startElevationSource: "phase11f3",
    summitElevationMeters: 2000,
    verticalGainMeters: 1200,
  });
  assert.equal(qualification.greenClass, "GREEN_MISSING_NAME");
  const resolution = resolve({ startContext: "BASE_START", startEntity: null, summitEntity: null });
  assert.equal(resolution.nameStatus, "UNRESOLVED");
  assert.equal(isNameReady(resolution.nameStatus), false);
  // Name status never alters the safety classification.
  assert.equal(qualification.safeStatus, "GREEN");
  assert.equal(qualification.greenClass, "GREEN_MISSING_NAME");
});

test("11H: human QA REJECTED stays publication-blocked regardless of name status", () => {
  const input: Phase11gQualificationInput = {
    canonicalRouteSourceId: "route-1",
    sourceUrl: "https://www.openstreetmap.org/relation/1",
    routeName: "Rejected Ascent",
    semanticType: "summit_route",
    routeType: "hiking",
    activityManualReviewRequired: false,
    geometryValid: true,
    qualityScore: 95,
    auditFlags: [],
    warnings: [],
    summits: [{ peakOsmId: "peak-1", finalAssociation: "CONFIRMED", endpointDistanceMeters: 2 }],
    topologyClassification: "SIMPLE",
    connectedGroupCount: 1,
    physicalEndpointCount: 2,
    endpointSelectionAmbiguous: false,
    explicitlySupportedClosedLoop: false,
    active: false,
    duplicateRelationIdentity: false,
    duplicateSourceUrl: false,
    publicationSourceConflict: false,
    dataIntegrityFailure: false,
    routeMemberDataIntegrityFailure: false,
    roadSafetyStatus: "SAFE",
    roadSafetyReasonCodes: [],
    humanQaStatus: "REJECTED",
    startContext: "BASE_START",
    startElevationMeters: 800,
    startElevationSource: "phase11f3",
    summitElevationMeters: 2000,
    verticalGainMeters: 1200,
  };
  const qualification = qualifyPhase11gRoute(input);
  assert.equal(qualification.safeStatus, "RED");
  assert.equal(qualification.greenClass, null);
  assert.ok(qualification.reasonCodes.includes("HUMAN_QA_REJECTED"));
  // A name status cannot un-block a REJECTED route.
  assert.equal(isNameReady("SOURCE_NAME"), true);
  assert.equal(qualification.safeStatus, "RED");
});

test("11H: resolution hash is deterministic and content-locked", () => {
  const first = resolve({ rawTags: { name: "Weg" }, startEntity: null, summitEntity: null });
  const second = resolve({ rawTags: { name: "Weg" }, startEntity: null, summitEntity: null });
  assert.equal(first.deterministicResolutionHash, second.deterministicResolutionHash);
  const content = Object.fromEntries(
    Object.entries(first).filter(([key]) => key !== "deterministicResolutionHash"),
  );
  assert.equal(first.deterministicResolutionHash, sha256Stable(content));
  const different = resolve({ rawTags: { name: "Anderer Weg" }, startEntity: null, summitEntity: null });
  assert.notEqual(first.deterministicResolutionHash, different.deterministicResolutionHash);
});

test("11H: derived display name uses en dash composition", () => {
  assert.equal(composeDerivedDisplayName("Rifugio", "Peak"), "Rifugio – Peak");
});

test("11H: normalizeNameForCompare normalizes case and whitespace", () => {
  assert.equal(normalizeNameForCompare("  Monte   Bianco "), "monte bianco");
});

test("11H: qualityBand thresholds are strict and exclusive", () => {
  assert.equal(qualityBand(89), "Q75_89");
  assert.equal(qualityBand(90), "Q90");
  assert.equal(qualityBand(74), "Q65_74");
  assert.equal(qualityBand(75), "Q75_89");
});

test("11H: ref classification never promotes ref to a name", () => {
  assert.equal(classifyRouteRef(null), "NO_REF");
  assert.equal(classifyRouteRef(""), "NO_REF");
  assert.equal(classifyRouteRef("149"), "TECHNICAL_ONLY_REF");
  assert.equal(classifyRouteRef("1491805"), "TECHNICAL_ONLY_REF");
  assert.equal(classifyRouteRef("7C"), "TECHNICAL_ONLY_REF");
  assert.equal(classifyRouteRef("Schwarzwaldweg"), "HUMAN_MEANINGFUL_REF");
  const resolution = resolve({ rawTags: { ref: "Schwarzwaldweg" }, startEntity: null, summitEntity: null });
  assert.equal(resolution.refKind, "HUMAN_MEANINGFUL_REF");
  assert.equal(resolution.nameStatus, "REF_ONLY");
  assert.equal(resolution.derivedDisplayName, null);
});

test("11H: ambiguity window constant is exactly 50 m", () => {
  assert.equal(PHASE11H_DERIVED_AMBIGUITY_WINDOW_METERS, 50);
});