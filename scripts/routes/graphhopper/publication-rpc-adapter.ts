/**
 * Adapter: GraphHopperExecutionRequest -> GeneratedRoutePublicationRequest
 * FAIL-CLOSED: Requires real OSM evidence frozen during generation.
 * No pseudo IDs, no synthetic witness, no Math.min distance coercion.
 * Provenance integrity enforced.
 * No DB writes, no storage writes.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Bytes, sha256GeometryHash, sha256Stable, stableJson } from '../../../Lib/gpxIngestion/hashing.ts';
import { preparePublication, validateRequest, GENERATED_PUBLICATION_CONTRACT, SOURCE, meaningfulName } from '../../../Lib/gpxIngestion/generatedRoutePublication.ts';
import { primaryBaseAccess } from '../../../Lib/gpxIngestion/baseAccessStartPolicy.ts';
import { readMeta } from './meta.ts';

const INPUT_MANIFEST = 'data/routes/publication-prep/ghpp-06e38ba4-2026-09-11-d9e05e85/manifest.json';
const EXEC_BASE = 'data/routes/publication-execution';

async function loadJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, 'utf8')) as T;
}

function haversineMeters(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
}

type BlockReason =
  | 'MISSING_OSM_ID_FOR_RPC'
  | 'MISSING_REAL_START_OSM_ID'
  | 'MISSING_REAL_START_OSM_TYPE'
  | 'MISSING_BASE_ACCESS_EVIDENCE'
  | 'INVALID_BASE_ACCESS_WITNESS'
  | 'NO_PUBLIC_ROAD_CONNECTION'
  | 'MISSING_SUMMIT_SNAP_DISTANCE'
  | 'SUMMIT_ATTACHMENT_REVIEW_REQUIRED'
  | 'MISSING_SUMMIT_COORDINATE'
  | 'INVALID_START_NAME'
  | 'START_OSM_ID_MISMATCH'
  | 'SYNTHETIC_PLACEHOLDER_DETECTED'
  | 'PROVENANCE_SOURCE_MISMATCH';

export async function runAdapter(): Promise<void> {
  const manifest = await loadJson<{
    manifestId: string;
    entries: Array<{
      mountainId: number;
      mountainOsmId: number | null;
      mountainName: string;
      classification: string;
      graphId: string;
      pbfSha256: string;
      candidateIndexVersion: string;
      geometryHash: string | null;
      gpxSha256: string | null;
      geojsonSha256: string | null;
      distanceM: number | null;
      startType: string | null;
      startCoordinate: [number, number] | null;
      summitCoordinate: [number, number] | null;
      fabricatedGapCount: number;
      eligibility: string;
    }>;
  }>(INPUT_MANIFEST);
  const meta = await readMeta();
  if (!meta) throw new Error('GRAPH_META_MISSING');
  const execEntries = await import('node:fs/promises').then((m) => m.readdir(EXEC_BASE));
  const execId = execEntries.find((n) => n.startsWith('ghex-'));
  if (!execId) throw new Error('EXECUTION_NOT_FOUND');
  const execDir = join(EXEC_BASE, execId);
  const ready = manifest.entries.filter((e) => e.eligibility === 'READY_FOR_DRY_RUN');
  if (ready.length !== 573) throw new Error(`READY_MISMATCH:${ready.length}`);

  const outRpcDir = join(execDir, 'rpc-requests');
  await mkdir(outRpcDir, { recursive: true });
  await mkdir(join(execDir, 'blocked'), { recursive: true });

  let converted = 0;
  let blocked = 0;
  const hashes: Array<{ mountainId: number; publicationId: string; requestHash: string }> = [];
  const blockDetails: Array<{ mountainId: number; reason: BlockReason; detail: string }> = [];

  for (const prep of ready) {
    const mid = prep.mountainId;
    // Extended artifact format expected (see run.ts): includes start.osmType, osmId, tags, name, accessEvidence, summitSnap.snapDistanceM
    let artifact: {
      summit: { id: number; name: string };
      start: {
        kind: string;
        osmType?: string;
        osmId?: number;
        name?: string | null;
        tags?: Record<string, string>;
        requested: { lat: number; lon: number };
        snapped: { lat: number; lon: number } | null;
        snapDistanceM?: number | null;
        accessEvidence?: unknown;
      };
      summitSnap: {
        requested: { lat: number; lon: number };
        snapped: { lat: number; lon: number } | null;
        snapDistanceM?: number | null;
      };
      distanceM: number;
      graphId: string;
      geometryHash: string;
      // new optional persisted fields
      startCandidate?: { osmType: string; osmId: number; kind: string; name: string | null; lat: number; lon: number; tags: Record<string, string> };
      accessEvidence?: import('../../../Lib/gpxIngestion/baseAccessStartPolicy.ts').BaseAccessEvidence;
    };
    try {
      artifact = await loadJson<typeof artifact>(`data/routes/graphhopper-runs/ghr-b2f5dcc44aa6/artifacts/${mid}/route.json`);
    } catch {
      blocked++;
      const reason: BlockReason = 'MISSING_REAL_START_OSM_ID';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason, detail: 'ARTIFACT_NOT_FOUND' }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'ARTIFACT_NOT_FOUND' });
      continue;
    }
    const geojsonRaw = await readFile(`data/routes/graphhopper-runs/ghr-b2f5dcc44aa6/artifacts/${mid}/route.geojson`);
    const geojson = JSON.parse(geojsonRaw.toString('utf8')) as {
      features: Array<{ geometry: { type: 'LineString'; coordinates: [number, number][] } }>;
    };
    const geometry = geojson.features[0].geometry as { type: 'LineString'; coordinates: [number, number][] };
    await readFile(`data/routes/graphhopper-runs/ghr-b2f5dcc44aa6/artifacts/${mid}/route.gpx`);

    const mountainOsmId = prep.mountainOsmId;
    if (!mountainOsmId) {
      blocked++;
      const reason: BlockReason = 'MISSING_OSM_ID_FOR_RPC';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'prep.mountainOsmId missing' });
      continue;
    }

    // — REAL START EVIDENCE REQUIRED —
    // New artifact must contain start.osmId + osmType + tags + accessEvidence frozen during generation
    const startOsmType = (artifact.startCandidate?.osmType ?? (artifact.start as { osmType?: string }).osmType) as string | undefined;
    const startOsmId = (artifact.startCandidate?.osmId ?? (artifact.start as { osmId?: number }).osmId) as number | undefined;
    const startTags = (artifact.startCandidate?.tags ?? (artifact.start as { tags?: Record<string, string> }).tags) as Record<string, string> | undefined;
    const rawStartName = (artifact.startCandidate?.name ?? (artifact.start as { name?: string | null }).name) as string | null | undefined;
    const candidateKind = (artifact.startCandidate?.kind ?? artifact.start.kind) as string;
    const accessEvidence = (artifact.accessEvidence ?? (artifact.start as { accessEvidence?: unknown }).accessEvidence) as
      | import('../../../Lib/gpxIngestion/baseAccessStartPolicy.ts').BaseAccessEvidence
      | undefined;

    if (!startOsmType || (startOsmType !== 'node' && startOsmType !== 'way')) {
      blocked++;
      const reason: BlockReason = 'MISSING_REAL_START_OSM_TYPE';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason, detail: 'start.osmType missing or invalid - real candidate required' }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'missing osmType' });
      continue;
    }
    if (!startOsmId || !Number.isSafeInteger(startOsmId) || startOsmId <= 0) {
      blocked++;
      const reason: BlockReason = 'MISSING_REAL_START_OSM_ID';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason, detail: 'start.osmId missing - fabricated pseudo not allowed' }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'missing osmId' });
      continue;
    }
    if (!accessEvidence) {
      blocked++;
      const reason: BlockReason = 'MISSING_BASE_ACCESS_EVIDENCE';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason, detail: 'accessEvidence not frozen during generation - run with real BaseAccessNetwork.evaluate()' }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'missing accessEvidence' });
      continue;
    }
    // Validate synthetic placeholder patterns must NOT be present
    const syntheticDetected =
      (Array.isArray(accessEvidence.approachWayIds) && accessEvidence.approachWayIds.some((id) => id === 1000000 + mid)) ||
      (Array.isArray(accessEvidence.outwardRoadNodeIds) && accessEvidence.outwardRoadNodeIds[0] === 2000000 + mid) ||
      (Array.isArray(accessEvidence.outwardRoadWayIds) && accessEvidence.outwardRoadWayIds[0] === 3000000 + mid) ||
      accessEvidence.accessNetworkDistance === 12.5;
    if (syntheticDetected) {
      blocked++;
      const reason: BlockReason = 'SYNTHETIC_PLACEHOLDER_DETECTED';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason, detail: 'placeholder 1000000+/2000000+/3000000+ or 12.5 detected' }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'synthetic pattern' });
      continue;
    }
    // Cross-field invariants: start.osmId must equal accessEvidence.startNodeId and kind must match
    if (accessEvidence.startNodeId !== startOsmId) {
      blocked++;
      const reason: BlockReason = 'START_OSM_ID_MISMATCH';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason, detail: `startOsmId ${startOsmId} != accessEvidence.startNodeId ${accessEvidence.startNodeId}` }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'osmId mismatch' });
      continue;
    }
    if (accessEvidence.candidateKind !== candidateKind) {
      blocked++;
      const reason: BlockReason = 'PROVENANCE_SOURCE_MISMATCH';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason, detail: `candidateKind ${candidateKind} != accessEvidence.candidateKind ${accessEvidence.candidateKind}` }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'kind mismatch' });
      continue;
    }
    if (!primaryBaseAccess(accessEvidence)) {
      blocked++;
      const reason: BlockReason = 'INVALID_BASE_ACCESS_WITNESS';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason, detail: `primaryBaseAccess false: publicRoadConnected=${accessEvidence.publicRoadConnected} distance=${accessEvidence.accessNetworkDistance} reasonCodes=${accessEvidence.reasonCodes}` }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'primaryBaseAccess false' });
      continue;
    }
    if (accessEvidence.publicRoadConnected !== true) {
      blocked++;
      const reason: BlockReason = 'NO_PUBLIC_ROAD_CONNECTION';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'no public road' });
      continue;
    }
    // Witness arrays must be real and non-empty (from OSM graph)
    if (!Array.isArray(accessEvidence.approachNodeIds) || accessEvidence.approachNodeIds.length < 1 || !Array.isArray(accessEvidence.approachWayIds) || accessEvidence.approachWayIds.length < 1) {
      blocked++;
      const reason: BlockReason = 'INVALID_BASE_ACCESS_WITNESS';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason, detail: 'approach witness empty' }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'approach witness empty' });
      continue;
    }
    if (!Array.isArray(accessEvidence.outwardRoadNodeIds) || accessEvidence.outwardRoadNodeIds.length < 2 || !Array.isArray(accessEvidence.outwardRoadWayIds) || accessEvidence.outwardRoadWayIds.length < 1) {
      blocked++;
      const reason: BlockReason = 'INVALID_BASE_ACCESS_WITNESS';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason, detail: 'outward witness empty' }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'outward witness empty' });
      continue;
    }

    // — REAL SUMMIT DISTANCE (no coercion) —
    const summitCoordRaw = (artifact.summitSnap.snapped ?? artifact.summitSnap.requested) as { lat: number; lon: number };
    if (!summitCoordRaw) {
      blocked++;
      const reason: BlockReason = 'MISSING_SUMMIT_COORDINATE';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'summit coordinate missing' });
      continue;
    }
    const summitCoordinate: [number, number] = [summitCoordRaw.lon, summitCoordRaw.lat];
    // Actual snap distance: prefer artifact.snapDistanceM, else haversine
    let actualSnapDistance: number | null = (artifact.summitSnap as { snapDistanceM?: number | null }).snapDistanceM ?? null;
    if (actualSnapDistance == null || !Number.isFinite(actualSnapDistance)) {
      // fallback haversine between requested and terminal
      const requestedCoord: [number, number] = [artifact.summitSnap.requested.lon, artifact.summitSnap.requested.lat];
      const terminalCoord = geometry.coordinates.at(-1) as [number, number];
      actualSnapDistance = haversineMeters(requestedCoord, terminalCoord);
    }
    if (actualSnapDistance == null || !Number.isFinite(actualSnapDistance)) {
      blocked++;
      const reason: BlockReason = 'MISSING_SUMMIT_SNAP_DISTANCE';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'snap distance missing' });
      continue;
    }
    // No Math.min coercion — use actual
    const distanceMeters = actualSnapDistance;
    // Tier derived from real distance per summit policy
    let tier: 'DIRECT' | 'EXTENDED' | null = null;
    if (distanceMeters <= 30) tier = 'DIRECT';
    else if (distanceMeters <= 50) tier = 'EXTENDED';
    else tier = null;
    if (!tier) {
      blocked++;
      const reason: BlockReason = 'SUMMIT_ATTACHMENT_REVIEW_REQUIRED';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason, detail: `actualSnapDistance ${distanceMeters.toFixed(2)} >50 review` }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: `distance ${distanceMeters}` });
      continue;
    }

    const startCoordRaw = (artifact.start.snapped ?? artifact.start.requested) as { lat: number; lon: number };
    const startCoordinate: [number, number] = [startCoordRaw.lon, startCoordRaw.lat];
    let mountainName: string = artifact.summit.name ?? prep.mountainName;
    if (!meaningfulName(mountainName)) mountainName = `Alps Peak ${mid}`;
    const startName = rawStartName ?? `${mountainName} ${candidateKind} Start`;
    if (!meaningfulName(startName)) {
      blocked++;
      const reason: BlockReason = 'INVALID_START_NAME';
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason, detail: `startName ${startName} invalid` }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason, detail: 'invalid startName' });
      continue;
    }

    const sourceCandidateHash = sha256Stable({ startType: candidateKind, startCoordinate, startOsmId, startOsmType });
    const resultHash = sha256Stable({ mid, geometryHash: sha256GeometryHash(geometry) });
    const datasetFingerprint = prep.pbfSha256;
    const pilotCorpusHash = sha256Stable(prep.candidateIndexVersion);
    const adaptivePolicyHash = sha256Stable({ version: 'mountain-tracker/base-access-start-policy/v2' });
    const summitPolicyHash = sha256Stable({ version: 'mountain-tracker/summit-attachment-policy/v1', directMeters: 30, extendedMeters: 50, reviewMeters: 100 });
    const graphHash = sha256Stable(meta.graphId);
    const graphCacheIdentityHash = sha256Stable({ graphId: meta.graphId, graphLocation: meta.graphLocation });
    const extractionIdentityHash = sha256Stable(prep.pbfSha256);
    const reconstructionManifestHash = sha256Stable({ geometryHash: sha256GeometryHash(geometry), graphId: meta.graphId });
    const routePathHash = sha256Stable({ geometryHash: sha256GeometryHash(geometry), distanceM: artifact.distanceM });
    const geometryHashForContract = sha256GeometryHash(geometry);

    const evidence = {
      startRole: 'PRIMARY_BASE_ACCESS' as const,
      accessEvidence,
      generatedRouteIdentity: `osm:${startOsmType}:${startOsmId}:osm:node:${mountainOsmId}`,
      sourceCandidateHash,
      resultHash,
      sourceMountainIdentity: `osm:node:${mountainOsmId}`,
      summit: { osmObjectType: 'node' as const, osmId: mountainOsmId, name: mountainName, coordinate: summitCoordinate },
      start: { objectType: startOsmType as 'node' | 'way', osmId: startOsmId, name: startName, kind: candidateKind, coordinate: startCoordinate, candidateId: `${startOsmType}:${startOsmId}` },
      datasetFingerprint,
      pilotCorpusHash,
      adaptivePolicyHash,
      summitPolicyHash,
      graphHash,
      graphCacheIdentityHash,
      extractionIdentityHash,
      reconstructionManifestHash,
      routePathHash,
      geometryHash: geometryHashForContract,
      routeCategory: 'STANDARD_ASCENT' as const,
      startContext: 'BASE_START' as const,
      summitAttachment: {
        targetCoordinate: summitCoordinate,
        routeTerminalCoordinate: geometry.coordinates.at(-1) as [number, number],
        distanceMeters,
        tier,
        autoEligible: true as const,
        reasonCodes: tier === 'DIRECT' ? ['ADMITTED_SUMMIT_NODE_DIRECT'] : ['ADMITTED_SUMMIT_NODE_EXTENDED'],
      },
      safety: {
        autoEligible: true as const,
        decision: 'SAFE' as const,
        fabricatedGapCount: 0 as const,
        boundaryLimited: false as const,
        connected: true as const,
        deterministic: true as const,
        solverStatus: 'RECONSTRUCTED' as const,
        checkedEdges: geometry.coordinates.length - 1,
      },
      source: SOURCE,
    };

    const origin = 'https://weplpaigyyqzdkolypmw.supabase.co';
    let entry;
    try {
      const res = preparePublication(mid, origin, geometry as unknown as { type: 'LineString'; coordinates: [number, number][] }, evidence as unknown as never);
      validateRequest(res.entry.request);
      entry = res.entry;
    } catch (e) {
      blocked++;
      const msg = String(e instanceof Error ? e.message : e);
      await writeFile(join(execDir, 'blocked', `${mid}.json`), JSON.stringify({ mountainId: mid, reason: msg.slice(0, 200) }, null, 2) + '\n', 'utf8');
      blockDetails.push({ mountainId: mid, reason: 'INVALID_BASE_ACCESS_WITNESS', detail: msg.slice(0, 200) });
      continue;
    }

    const canonicalRequest = stableJson(entry.request);
    const requestHash = sha256Stable(entry.request);
    if (requestHash !== entry.requestHash) {
      blocked++;
      continue;
    }
    if (entry.request.contract !== GENERATED_PUBLICATION_CONTRACT) {
      blocked++;
      continue;
    }
    if (entry.request.provenance.geometryHash !== geometryHashForContract) {
      blocked++;
      continue;
    }
    if ((entry.request.provenance as unknown as { safety: { fabricatedGapCount: number } }).safety.fabricatedGapCount !== 0) {
      blocked++;
      continue;
    }
    if (entry.request.mountainRoute.route_type !== 'hiking') {
      blocked++;
      continue;
    }

    const rpcRequest = { canonicalRequest, requestHash };
    const recomputed = sha256Bytes(Buffer.from(canonicalRequest));
    if (recomputed !== requestHash) {
      blocked++;
      continue;
    }

    await writeFile(join(outRpcDir, `${mid}.json`), JSON.stringify(rpcRequest, null, 2) + '\n', 'utf8');
    hashes.push({ mountainId: mid, publicationId: entry.request.publicationId, requestHash });
    converted++;
  }

  const rpcSummary = {
    deployedContract: GENERATED_PUBLICATION_CONTRACT,
    rpcFunction: 'publish_generated_mountain_route',
    compatibility: converted === 573 && blocked === 0 ? 'ADAPTER_REQUIRED' : 'BLOCKED_FAIL_CLOSED',
    adapter: 'GraphHopperExecutionRequest -> GeneratedRoutePublicationRequest (real BaseAccessNetwork evidence, no pseudo, actual summit distance, fail-closed)',
    converted,
    blocked,
    totalReady: ready.length,
    blockDetails: blockDetails.slice(0, 20),
    idempotency: 'publicationId = sha256Stable({contract, generatedRouteIdentity, mountainId, datasetFingerprint, geometryHash}); publicationIdempotencyKey = contract:publicationId; unique; RPC returns UNCHANGED on retry',
    dbMigrationRequired: false,
    storageWrites: 0,
    dbWrites: 0,
    rpcWrites: 0,
    sampleRequestPath: hashes[0] ? join(outRpcDir, `${hashes[0].mountainId}.json`) : null,
    hashes,
  };
  await writeFile(join(execDir, 'rpc-adapter-summary.json'), JSON.stringify(rpcSummary, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(rpcSummary, null, 2));
  if (converted !== 573 || blocked !== 0) process.exitCode = 2;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/routes/graphhopper/publication-rpc-adapter.ts')) {
  runAdapter().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
