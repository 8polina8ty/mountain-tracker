/** Independent generated-route contract; never changes Phase 11 identities. */
import assert from 'node:assert/strict';
import { sha256Bytes, sha256GeometryHash, sha256Stable, stableJson } from './hashing.ts';
import type { AdaptiveStartCandidate } from './adaptiveStartDiscovery.ts';
import type { SummitAttachment } from './summitAttachment.ts';
import type { Coordinate, NormalizedTrackGeometry } from './types.ts';
import { calculateGeometryLengthMeters } from '../../scripts/osm-import/route-geometry.ts';
import { compareRoutes } from '../../scripts/osm-import/route-similarity.ts';
import { primaryBaseAccess, type BaseAccessEvidence } from './baseAccessStartPolicy.ts';

export const GENERATED_PUBLICATION_CONTRACT = 'mountain-tracker-generated-route-publication/v1';
export const MAX_PUBLICATION_BYTES = 10 * 1024 * 1024;
export const MIME = { geojson: 'application/geo+json', gpx: 'application/gpx+xml' } as const;
export const SOURCE = { name: 'OpenStreetMap', license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' } as const;
export type Line = { type: 'LineString'; coordinates: [number, number][] };
export type FrozenCandidate = Omit<AdaptiveStartCandidate, 'route'> & { route: {
  geometryHash: string; reconstructionManifestHash: string; solverVersion: string; graphHash: string;
  distanceM: number; osmNodeIds: number[]; osmWayIds: number[]; startCoordinate: Coordinate;
  terminalCoordinate: Coordinate; geometrySource: string;
} | null };
export interface FrozenRow {
  mountainId: string; name: string; blockId: string; stratum: string; status: string; graphStatus: string;
  reasons: string[]; summitAttachment: SummitAttachment | null; candidates: FrozenCandidate[];
  resultHash: string | null; determinismVerified: boolean | null;
}
export interface PublicationEvidence {
  startRole?: 'PRIMARY_BASE_ACCESS';
  accessEvidence?: BaseAccessEvidence;
  generatedRouteIdentity: string; sourceCandidateHash: string; resultHash: string;
  sourceMountainIdentity: string; summit: { osmObjectType: string; osmId: number; name: string; coordinate: Coordinate };
  start: { objectType: string; osmId: number; name: string; kind: string; coordinate: Coordinate; candidateId: string };
  datasetFingerprint: string; pilotCorpusHash: string; adaptivePolicyHash: string; summitPolicyHash: string;
  graphHash: string; graphCacheIdentityHash: string; extractionIdentityHash: string;
  reconstructionManifestHash: string; solverVersion: string; routePathHash: string;
  geometryHash: string; routeCategory: 'STANDARD_ASCENT' | 'HUT_ASCENT' | 'REMOTE_APPROACH'; startContext: 'BASE_START' | 'HUT_START';
  summitAttachment: SummitAttachment;
  safety: { autoEligible: true; decision: 'SAFE'; fabricatedGapCount: 0; boundaryLimited: false; connected: true; deterministic: true; solverStatus: 'RECONSTRUCTED'; checkedEdges: number };
  source: typeof SOURCE;
}
export interface MountainRoutePayload {
  mountain_id: number; name: string; start_location: string; route_type: 'hiking'; distance_km: number;
  difficulty_system: null; difficulty_value: null; elevation_gain_m: null; duration_minutes: null;
  description: null; best_season: null; equipment: null; warnings: null; created_by: null;
  source_name: 'OpenStreetMap'; source_url: string; is_verified: true; geojson_url: string; gpx_url: string;
}
export interface PublicationRequest {
  contract: typeof GENERATED_PUBLICATION_CONTRACT;
  publicationId: string; publicationIdempotencyKey: string;
  mountainRoute: MountainRoutePayload;
  provenance: PublicationEvidence & { publicationStatus: 'ACTIVE'; geojsonSha256: string; gpxSha256: string;
    storageBucket: 'route-gpx'; storagePaths: { geojson: string; gpx: string }; geojsonBytes: number; gpxBytes: number };
}
export interface PublicationEntry {
  request: PublicationRequest; requestHash: string;
  files: { geojson: { path: string; sha256: string; bytes: number; contentType: string }; gpx: { path: string; sha256: string; bytes: number; contentType: string } };
}
export interface CanaryManifest {
  contract: typeof GENERATED_PUBLICATION_CONTRACT; mode: 'DRY_RUN_ONLY';
  sourceArtifacts: Record<string, string>;
  checkpoint: { mountains: number; autoEligible: number; mountainsWithAuto: number; normalSuccess: number; sparseSuccess: number; componentLimit: number; falseAutoAccepts: number; fabricatedGapCount: number };
  selection: { policy: string; excluded: Array<{ mountain: string; candidate: string | null; reason: string }> };
  entries: PublicationEntry[];
}

export function meaningfulName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= 200 &&
    /\p{L}/u.test(value) && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/u.test(value) &&
    !/^(?:unnamed|unknown|parking|trailhead|hut|WILDERNESS_HUT|ALPINE_HUT|node|way|relation)(?:\s*[:#]?\s*\d+)?$/i.test(value.trim());
}

export function candidateEligible(row: FrozenRow, c: FrozenCandidate): boolean {
  return row.graphStatus === 'READY' && ['STARTS_FOUND', 'REMOTE_ACCESS_FOUND'].includes(row.status) && row.determinismVerified === true &&
    Boolean(row.resultHash) && !row.reasons.some(r => /BOUNDARY|LIMIT_REACHED|FAILED/.test(r)) &&
    c.autoEligible === true && c.safety === 'SAFE' && c.safetyReasons.length === 0 &&
    !c.reasons.some(r => /BOUNDARY|DISCONNECTED|FAILED|NEEDS_REVIEW/.test(r)) &&
    c.solverStatus === 'RECONSTRUCTED' && c.duplicateOf === null &&
    c.startRole === 'PRIMARY_BASE_ACCESS' && primaryBaseAccess(c.accessEvidence) &&
    c.kind === c.accessEvidence?.candidateKind && !/HUT|REFUGE/.test(c.kind) &&
    !['HUT_START', 'HIGH_MOUNTAIN_START'].includes(c.startContext?.type ?? '') &&
    ['STANDARD_ASCENT', 'REMOTE_APPROACH'].includes(c.category ?? '') &&
    c.anchor?.status === 'RESOLVED' && c.route?.geometrySource === 'OPENSTREETMAP' &&
    row.summitAttachment?.autoEligible === true && ['DIRECT', 'EXTENDED'].includes(row.summitAttachment.tier) &&
    (meaningfulName(c.tags.name) || c.accessEvidence?.approachBoundary === true && meaningfulName(c.name)) && meaningfulName(row.name);
}

export function validateLine(geometry: NormalizedTrackGeometry): asserts geometry is Line {
  assert.equal(geometry.type, 'LineString', 'DISCONNECTED_OR_MULTILINE_REJECTED');
  assert(geometry.coordinates.length >= 2, 'TOO_FEW_POINTS');
  for (const c of geometry.coordinates) assert(c.length === 2 && c.every(Number.isFinite) && Math.abs(c[0] as number) <= 180 && Math.abs(c[1] as number) <= 90, 'INVALID_OR_ELEVATED_COORDINATE');
}

export function distanceKm(geometry: Line): number {
  validateLine(geometry);
  return Math.round(calculateGeometryLengthMeters(geometry) * 1000) / 1_000_000;
}

export function assertInsideFrozenWindow(geometry: Line, bounds: readonly number[]): void {
  assert.equal(bounds.length,4);
  // A small conservative margin excludes paths touching the extraction boundary.
  assert(geometry.coordinates.every(([x,y])=>x>bounds[0]+0.0001 && x<bounds[2]-0.0001 && y>bounds[1]+0.0001 && y<bounds[3]-0.0001),'BOUNDARY_LIMITED_ROUTE_REJECTED');
}

export function publicationIdentity(mountainId: number, evidence: PublicationEvidence): string {
  return sha256Stable({ contract: GENERATED_PUBLICATION_CONTRACT, generatedRouteIdentity: evidence.generatedRouteIdentity,
    mountainId, datasetFingerprint: evidence.datasetFingerprint, geometryHash: evidence.geometryHash });
}

export function storagePath(id: string, kind: keyof typeof MIME): string {
  assert.match(id, /^[a-f0-9]{64}$/, 'INVALID_PUBLICATION_ID');
  assert(['geojson', 'gpx'].includes(kind), 'INVALID_FILE_KIND');
  return `generated/${id}/route.${kind}`;
}

export function publicStorageUrl(origin: string, id: string, kind: keyof typeof MIME): string {
  const url = new URL(origin);
  assert(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'INVALID_STORAGE_ORIGIN');
  return `${url.origin}/storage/v1/object/public/route-gpx/${storagePath(id, kind)}`;
}

export function xmlEscape(text: string): string {
  assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text), 'INVALID_XML_TEXT');
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function serializeGpx(name: string, geometry: NormalizedTrackGeometry): string {
  validateLine(geometry);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Mountain Tracker" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/1-0/</license></copyright></metadata>\n  <trk><name>${xmlEscape(name)}</name><trkseg>\n` +
    geometry.coordinates.map(([lon, lat]) => `    <trkpt lat="${lat}" lon="${lon}"/>\n`).join('') +
    '  </trkseg></trk>\n</gpx>\n';
}

export function serializeGeojson(name: string, geometry: NormalizedTrackGeometry, evidence: PublicationEvidence): string {
  validateLine(geometry);
  return stableJson({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name, source: SOURCE.name }, geometry }],
    mountainTracker: { contract: GENERATED_PUBLICATION_CONTRACT, topologyEndpoints: { startCoordinate: geometry.coordinates[0], endCoordinate: geometry.coordinates.at(-1) },
      targetSummitCoordinate: evidence.summit.coordinate, routeTerminalCoordinate: geometry.coordinates.at(-1),
      summitProximityMeters: evidence.summitAttachment.distanceMeters, summitAttachmentTier: evidence.summitAttachment.tier,
      routeCategory: evidence.routeCategory, provenance: evidence } }) + '\n';
}

export function checkObjectSize(bytes: number, bucketLimit: number | null = MAX_PUBLICATION_BYTES): void {
  assert(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= Math.min(bucketLimit ?? MAX_PUBLICATION_BYTES, MAX_PUBLICATION_BYTES), 'STORAGE_SIZE_CEILING');
}

export function obviousDuplicate(a: Line, b: Line, summit = 'canary'): boolean {
  const comparable = (geometry: Line, sourceId: string) => ({ geometry, sourceId, name: sourceId, summitEvidence: { confirmedPeakIds: [summit], associatedPeakIds: [] } });
  return ['EXACT_DUPLICATE', 'NEAR_DUPLICATE'].includes(compareRoutes(comparable(a, 'a'), comparable(b, 'b')).classification);
}

export function preparePublication(mountainId: number, origin: string, geometry: Line, evidence: PublicationEvidence) {
  assertPrimaryPublication(evidence);
  validateLine(geometry);
  assert.equal(sha256GeometryHash(geometry), evidence.geometryHash, 'FROZEN_GEOMETRY_CHANGED');
  const publicationId = publicationIdentity(mountainId, evidence);
  const name = `${evidence.start.name} → ${evidence.summit.name}`;
  const geojson = serializeGeojson(name, geometry, evidence), gpx = serializeGpx(name, geometry);
  const geojsonBytes = Buffer.byteLength(geojson), gpxBytes = Buffer.byteLength(gpx);
  checkObjectSize(geojsonBytes); checkObjectSize(gpxBytes);
  const request: PublicationRequest = { contract: GENERATED_PUBLICATION_CONTRACT, publicationId,
    publicationIdempotencyKey: `${GENERATED_PUBLICATION_CONTRACT}:${publicationId}`,
    mountainRoute: { mountain_id: mountainId, name, start_location: evidence.start.name, route_type: 'hiking', distance_km: distanceKm(geometry),
      difficulty_system: null, difficulty_value: null, elevation_gain_m: null, duration_minutes: null, description: null,
      best_season: null, equipment: null, warnings: null, created_by: null, source_name: 'OpenStreetMap', source_url: SOURCE.url,
      is_verified: true, geojson_url: publicStorageUrl(origin, publicationId, 'geojson'), gpx_url: publicStorageUrl(origin, publicationId, 'gpx') },
    provenance: { ...evidence, publicationStatus: 'ACTIVE', geojsonSha256: sha256Bytes(Buffer.from(geojson)), gpxSha256: sha256Bytes(Buffer.from(gpx)),
      storageBucket: 'route-gpx', storagePaths: { geojson: storagePath(publicationId, 'geojson'), gpx: storagePath(publicationId, 'gpx') }, geojsonBytes, gpxBytes } };
  validateRequest(request);
  const entry: PublicationEntry = { request, requestHash: sha256Stable(request), files: {
    geojson: { path: `preview/${publicationId}/route.geojson`, sha256: request.provenance.geojsonSha256, bytes: geojsonBytes, contentType: MIME.geojson },
    gpx: { path: `preview/${publicationId}/route.gpx`, sha256: request.provenance.gpxSha256, bytes: gpxBytes, contentType: MIME.gpx } } };
  return { entry, geojson, gpx };
}

/** V1 structural validation remains available for auditing already-live immutable receipts. */
export function validateRequest(r: PublicationRequest): void {
  assert.equal(r.contract, GENERATED_PUBLICATION_CONTRACT);
  const p = r.provenance, m = r.mountainRoute;
  assert(Number.isSafeInteger(m.mountain_id) && m.mountain_id > 0);
  assert.equal(r.publicationId, publicationIdentity(m.mountain_id, p));
  assert.equal(r.publicationIdempotencyKey, `${GENERATED_PUBLICATION_CONTRACT}:${r.publicationId}`);
  for (const key of ['sourceCandidateHash', 'resultHash', 'datasetFingerprint', 'pilotCorpusHash', 'adaptivePolicyHash', 'summitPolicyHash', 'graphHash', 'graphCacheIdentityHash', 'extractionIdentityHash', 'reconstructionManifestHash', 'routePathHash', 'geometryHash', 'geojsonSha256', 'gpxSha256'] as const) assert.match(p[key], /^[a-f0-9]{64}$/, key);
  assert.equal(p.generatedRouteIdentity, `${p.sourceMountainIdentity}:${p.start.candidateId}`);
  assert.equal(p.sourceMountainIdentity, `osm:${p.summit.osmObjectType}:${p.summit.osmId}`);
  assert.equal(p.start.candidateId, `${p.start.kind === 'NETWORK_ACCESS' ? 'network' : p.start.objectType}:${p.start.osmId}`);
  assert(meaningfulName(p.start.name) && meaningfulName(p.summit.name));
  assert.deepEqual(p.source, SOURCE);
  assert.deepEqual(p.safety, { autoEligible: true, decision: 'SAFE', fabricatedGapCount: 0, boundaryLimited: false, connected: true, deterministic: true, solverStatus: 'RECONSTRUCTED', checkedEdges: p.safety.checkedEdges });
  assert(Number.isSafeInteger(p.safety.checkedEdges) && p.safety.checkedEdges > 0);
  assert(['BASE_START', 'HUT_START'].includes(p.startContext));
  if (p.startRole) {
    assertPrimaryPublication(p);
    assert(['STANDARD_ASCENT', 'REMOTE_APPROACH'].includes(p.routeCategory));
  } else assert.equal(p.routeCategory, p.startContext === 'HUT_START' ? 'HUT_ASCENT' : 'STANDARD_ASCENT');
  assert(p.summitAttachment.autoEligible && ['DIRECT', 'EXTENDED'].includes(p.summitAttachment.tier));
  assert(p.summitAttachment.distanceMeters >= 0 && p.summitAttachment.distanceMeters <= (p.summitAttachment.tier === 'DIRECT' ? 30 : 50));
  assert.deepEqual(p.summitAttachment.targetCoordinate, p.summit.coordinate);
  assert.equal(p.publicationStatus, 'ACTIVE'); assert.equal(p.storageBucket, 'route-gpx');
  assert.equal(m.name, `${p.start.name} → ${p.summit.name}`); assert.equal(m.start_location, p.start.name);
  assert.equal(m.route_type, 'hiking'); assert.equal(m.is_verified, true);
  assert.equal(m.source_name, SOURCE.name); assert.equal(m.source_url, SOURCE.url);
  assert(Number.isFinite(m.distance_km) && m.distance_km > 0 && m.distance_km <= 100);
  for (const key of ['difficulty_system', 'difficulty_value', 'elevation_gain_m', 'duration_minutes', 'description', 'best_season', 'equipment', 'warnings', 'created_by'] as const) assert.equal(m[key], null);
  const origin = new URL(m.geojson_url).origin;
  for (const kind of ['geojson', 'gpx'] as const) {
    assert.equal(p.storagePaths[kind], storagePath(r.publicationId, kind));
    assert.equal(m[`${kind}_url`], publicStorageUrl(origin, r.publicationId, kind));
    checkObjectSize(p[`${kind}Bytes`]);
  }
}

/** Required at every new preparation and before any execute-side IO, including resume. */
export function assertPrimaryPublication(p: PublicationEvidence): void {
  assert(p.startRole === 'PRIMARY_BASE_ACCESS' && primaryBaseAccess(p.accessEvidence), 'PRIMARY_BASE_ACCESS_REQUIRED');
  assert.equal(p.start.kind, p.accessEvidence!.candidateKind, 'PRIMARY_START_KIND_MISMATCH');
  assert(!/HUT|REFUGE/.test(p.start.kind) && p.startContext !== 'HUT_START' && p.routeCategory !== 'HUT_ASCENT', 'HUT_SECONDARY_ONLY');
  assert(p.safety.autoEligible && p.safety.decision === 'SAFE' && p.safety.connected && p.safety.deterministic &&
    p.safety.fabricatedGapCount === 0 && p.safety.solverStatus === 'RECONSTRUCTED' && !p.safety.boundaryLimited,
    'PRIMARY_SAFETY_REQUIRED');
  assert(p.summitAttachment.autoEligible && ['DIRECT', 'EXTENDED'].includes(p.summitAttachment.tier), 'PRIMARY_SUMMIT_ATTACHMENT_REQUIRED');
}

export function existingPublicationAction(request: PublicationRequest, existing: { request_hash: string; publication_status: string } | undefined): 'UNCHANGED' | 'CREATE' {
  validateRequest(request);
  if (!existing) return 'CREATE';
  assert.equal(existing.publication_status, 'ACTIVE', 'EXISTING_STATUS_DRIFT');
  assert.equal(existing.request_hash, sha256Stable(request), 'CHANGED_HASH_FAIL_CLOSED');
  return 'UNCHANGED';
}

/** Called only after a definite DB rejection AND a successful absence reconciliation.
 * Ambiguous commit/network outcomes must retain objects for manual reconciliation. */
export function compensationTargets(planned: string[], newlyCreated: string[], databaseOutcome: 'ABSENT' | 'COMMITTED' | 'UNKNOWN'): string[] {
  const allowed = new Set(planned);
  for (const path of [...planned, ...newlyCreated]) assert(/^generated\/[a-f0-9]{64}\/route\.(gpx|geojson)$/.test(path), 'INVALID_COMPENSATION_PATH');
  assert(newlyCreated.every(path => allowed.has(path)), 'COMPENSATION_OUTSIDE_THIS_PUBLICATION');
  return databaseOutcome === 'ABSENT' ? [...new Set(newlyCreated)] : [];
}
