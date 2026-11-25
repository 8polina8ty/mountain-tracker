/** Reconstruct REAL Base Access evidence from frozen PBF / candidate index for 573 GH routes.
 * READ ONLY — no DB writes, no storage writes, geometry immutable.
 * Fail closed: no synthetic IDs, no Math.min, no invented witness.
 * Uses frozen sources: PBF sha, candidate index, original artifacts, manifest.
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadCandidateIndex, type RawCandidate } from './candidate-index.ts';
import { readMeta } from './meta.ts';

const MANIFEST_PATH = 'data/routes/publication-prep/ghpp-06e38ba4-2026-09-11-d9e05e85/manifest.json';
const ARTIFACT_BASE = 'data/routes/graphhopper-runs/ghr-b2f5dcc44aa6/artifacts';
const OUT_BASE = 'identity-repair/provenance-integrity/reconstructed';
const PBF_SHA = '15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5';

type ManifestEntry = { mountainId: number; mountainOsmId: number | null; mountainName: string };

function haversine(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
}

function geometryHash(coords: [number, number][]): string {
  return createHash('sha256').update(JSON.stringify({ type: 'LineString', coordinates: coords })).digest('hex');
}

export async function reconstruct(): Promise<void> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as { entries: ManifestEntry[]; manifestId: string };
  const ready = manifest.entries.filter((e: unknown) => (e as { eligibility: string }).eligibility === 'READY_FOR_DRY_RUN') as unknown as (ManifestEntry & { eligibility: string })[];
  if (ready.length !== 573) throw new Error(`READY_MISMATCH ${ready.length}`);
  const candidateIndex = await loadCandidateIndex();
  if (!candidateIndex) throw new Error('CANDIDATE_INDEX_MISSING');
  const meta = await readMeta();
  if (!meta) throw new Error('GRAPH_META_MISSING');
  if (meta.pbfSha256 !== PBF_SHA) throw new Error(`PBF_SHA_MISMATCH ${meta.pbfSha256} != ${PBF_SHA}`);
  const candidateByCoord = new Map<string, RawCandidate[]>();
  for (const c of candidateIndex.candidates) {
    const key = `${c.lat.toFixed(7)}:${c.lon.toFixed(7)}:${c.kind}`;
    const arr = candidateByCoord.get(key) ?? [];
    arr.push(c);
    candidateByCoord.set(key, arr);
  }

  await mkdir(OUT_BASE, { recursive: true });

  let realValid = 0;
  let reviewRequired = 0;
  let unrecoverable = 0;
  let invalidGeometry = 0;
  let direct = 0;
  let extended = 0;
  let over50 = 0;
  let geometryPreservedCount = 0;
  let noWitnessCount = 0;
  let ambiguousStartCount = 0;

  for (const entry of ready) {
    const mid = entry.mountainId;
    let artifact: {
      summit: { id: number; name: string };
      start: { kind: string; requested: { lat: number; lon: number }; snapped: { lat: number; lon: number } | null; snapDistanceM?: number | null };
      summitSnap: { requested: { lat: number; lon: number }; snapped: { lat: number; lon: number } | null; snapDistanceM?: number | null };
      distanceM: number;
      geometryHash: string;
      startCandidate?: { osmType: string; osmId: number; kind: string; name: string | null; lat: number; lon: number; tags: Record<string, string> };
    } | null = null;
    try {
      artifact = JSON.parse(await readFile(join(ARTIFACT_BASE, String(mid), 'route.json'), 'utf8'));
    } catch {
      artifact = null;
    }
    let geojson: { features: Array<{ geometry: { type: string; coordinates: [number, number][] } }> } | null = null;
    try {
      geojson = JSON.parse(await readFile(join(ARTIFACT_BASE, String(mid), 'route.geojson'), 'utf8'));
    } catch {
      geojson = null;
    }

    let classification: 'REAL_EVIDENCE_VALID' | 'REVIEW_REQUIRED' | 'UNRECOVERABLE_EVIDENCE' | 'INVALID_GEOMETRY_DRIFT' = 'UNRECOVERABLE_EVIDENCE';
    let tier: 'DIRECT' | 'EXTENDED' | null = null;
    let actualSnapDistanceM: number | null = null;
    let terminalDistanceM: number | null = null;
    let geometryPreserved = false;
    let startCandidate: RawCandidate | null = null;
    let recoverReason = '';
    let summitReason = '';

    // Geometry immutability: recompute hash
    if (geojson && artifact) {
      const coords = geojson.features[0]?.geometry.coordinates as [number, number][] | undefined;
      if (coords && coords.length >= 2) {
        const recomputed = geometryHash(coords);
        geometryPreserved = recomputed === artifact.geometryHash;
        if (geometryPreserved) geometryPreservedCount++;
        else {
          classification = 'INVALID_GEOMETRY_DRIFT';
          invalidGeometry++;
        }
      } else {
        classification = 'INVALID_GEOMETRY_DRIFT';
        invalidGeometry++;
      }
    } else {
      classification = 'INVALID_GEOMETRY_DRIFT';
      invalidGeometry++;
    }

    // Summit validation: actual snap distance
    if (artifact && classification !== 'INVALID_GEOMETRY_DRIFT') {
      const requested = artifact.summitSnap.requested;
      const terminalCoords = geojson?.features[0]?.geometry.coordinates?.at(-1) as [number, number] | undefined;
      const snapped = artifact.summitSnap.snapped;
      // actualSnapDistance is snapDistanceM if present, else haversine
      actualSnapDistanceM = artifact.summitSnap.snapDistanceM ?? null;
      if (actualSnapDistanceM == null && requested && terminalCoords) {
        const reqCoord: [number, number] = [requested.lon, requested.lat];
        if (snapped) actualSnapDistanceM = haversine(reqCoord, [snapped.lon, snapped.lat]);
        else actualSnapDistanceM = haversine(reqCoord, terminalCoords);
      }
      if (terminalCoords && requested) {
        terminalDistanceM = haversine([requested.lon, requested.lat], terminalCoords);
        // cross-check: if snapped exists, compare snapped distance vs terminal distance within 5m tolerance
        if (snapped && actualSnapDistanceM != null && Math.abs(actualSnapDistanceM - terminalDistanceM) > 5) {
          // Inconsistent but still use actualSnapDistance for tier; mark review
          summitReason = `INCONSISTENT_TERMINAL_VS_SNAPPED ${actualSnapDistanceM.toFixed(1)} vs ${terminalDistanceM.toFixed(1)}`;
        }
      }
      if (actualSnapDistanceM != null) {
        if (actualSnapDistanceM <= 30) {
          tier = 'DIRECT';
          direct++;
        } else if (actualSnapDistanceM <= 50) {
          tier = 'EXTENDED';
          extended++;
        } else {
          over50++;
          classification = 'REVIEW_REQUIRED';
          summitReason = `SUMMIT_SNAP_OVER_50 ${actualSnapDistanceM.toFixed(1)}`;
        }
      } else {
        classification = 'REVIEW_REQUIRED';
        summitReason = 'MISSING_SUMMIT_SNAP_DISTANCE';
      }
    }

    // Start candidate recovery
    if (artifact && classification !== 'INVALID_GEOMETRY_DRIFT') {
      // Prefer frozen startCandidate if present (new artifacts)
      if (artifact.startCandidate?.osmId) {
        const key = `${artifact.startCandidate.lat.toFixed(7)}:${artifact.startCandidate.lon.toFixed(7)}:${artifact.startCandidate.kind}`;
        const matches = candidateByCoord.get(key) ?? [];
        // Find exact osmId match
        const exact = matches.find((c) => c.osmId === artifact.startCandidate!.osmId && c.osmType === artifact.startCandidate!.osmType);
        if (exact) {
          startCandidate = exact;
          recoverReason = 'FROZEN_START_CANDIDATE_EXACT';
        } else {
          // If frozen candidate not in index (maybe outdated), treat as ambiguous/unrecoverable
          if (matches.length === 1) {
            startCandidate = matches[0];
            recoverReason = 'FROZEN_COORD_KIND_SINGLE_MATCH';
          } else if (matches.length > 1) {
            ambiguousStartCount++;
            classification = 'UNRECOVERABLE_EVIDENCE';
            recoverReason = 'AMBIGUOUS_START_CANDIDATE';
            startCandidate = null;
          } else {
            classification = 'UNRECOVERABLE_EVIDENCE';
            recoverReason = 'FROZEN_CANDIDATE_NOT_IN_INDEX';
          }
        }
      } else {
        // Legacy artifact: resolve via requested coordinate + kind
        const req = artifact.start.requested;
        const kind = artifact.start.kind;
        const key = `${req.lat.toFixed(7)}:${req.lon.toFixed(7)}:${kind}`;
        const matches = candidateByCoord.get(key) ?? [];
        // Also try tolerance search within 1e-6 (~0.1m) if exact key miss
        let candidates: RawCandidate[] = matches;
        if (candidates.length === 0) {
          // fallback: nearby search within 5 meters
          const eps = 0.00005; // ~5m
          candidates = candidateIndex.candidates.filter(
            (c) => c.kind === kind && Math.abs(c.lat - req.lat) < eps && Math.abs(c.lon - req.lon) < eps,
          );
        }
        if (candidates.length === 1) {
          startCandidate = candidates[0];
          recoverReason = 'LEGACY_COORD_KIND_SINGLE_MATCH';
        } else if (candidates.length === 0) {
          classification = 'UNRECOVERABLE_EVIDENCE';
          recoverReason = 'NO_CANDIDATE_MATCH';
        } else {
          ambiguousStartCount++;
          classification = 'UNRECOVERABLE_EVIDENCE';
          recoverReason = 'AMBIGUOUS_START_CANDIDATE';
          startCandidate = null;
        }
      }
    }

    // Real Base Access topology: attempt to evaluate via BaseAccessNetwork
    // For this reconstruction task, we have frozen PBF but not yet built OsmTrailGraph per mountain.
    // We will attempt a lightweight check: if startCandidate exists, we can say witness is UNRECOVERABLE until full graph is built.
    // However we can at least verify that candidate is not hut/refuge and kind is primary.
    // For now, classify as UNRECOVERABLE_EVIDENCE if no witness is available (since we cannot yet prove publicRoadConnected).
    // This is fail-closed: no synthetic witness.
    let realAccessEvidence: unknown = null;
    if (startCandidate && classification !== 'INVALID_GEOMETRY_DRIFT' && classification !== 'REVIEW_REQUIRED') {
      // Check primary start semantics
      const kind = startCandidate.kind;
      const isHut = /HUT|REFUGE/.test(kind) || ['alpine_hut', 'wilderness_hut'].includes(startCandidate.tags.tourism);
      const primaryKinds = new Set(['TRAILHEAD', 'PARKING', 'VILLAGE', 'HAMLET', 'TRAIN_STATION', 'HALT', 'BUS_STOP', 'PUBLIC_ROAD_END', 'TRAILHEAD_INFO', 'NETWORK_ACCESS']);
      if (isHut || !primaryKinds.has(kind)) {
        classification = 'REVIEW_REQUIRED';
        recoverReason += '|HUT_OR_NON_PRIMARY_KIND';
      } else {
        // Without full OSM trail graph, we cannot prove publicRoadConnected.
        // Mark as UNRECOVERABLE_EVIDENCE (needs full topology extraction in next phase)
        // This ensures no fabricated witness is used.
        noWitnessCount++;
        classification = 'UNRECOVERABLE_EVIDENCE';
        recoverReason += '|NO_REAL_BASE_ACCESS_WITNESS_YET';
        // We do not fabricate accessEvidence; leave as null for now
        realAccessEvidence = null;
      }
    } else if (!startCandidate && classification !== 'INVALID_GEOMETRY_DRIFT' && classification !== 'REVIEW_REQUIRED') {
      // already UNRECOVERABLE due to ambiguous/missing candidate
      noWitnessCount++;
    }

    // If summit already REVIEW_REQUIRED, keep that; otherwise if unrecoverable, keep unrecoverable
    // Only if everything valid and witness existed would be REAL_EVIDENCE_VALID — but currently witness missing so no REAL yet
    // For this phase, REAL_EVIDENCE_VALID requires full witness, which we don't have, so count remains 0
    // We keep classification as is: UNRECOVERABLE_EVIDENCE for those lacking witness

    // However, if summit was DIRECT/EXTENDED and candidate was uniquely recovered and no other blocker, we could still mark as REVIEW_REQUIRED vs UNRECOVERABLE
    // For now, we have 0 REAL, rest are UNRECOVERABLE or REVIEW_REQUIRED or INVALID

    if (classification === 'UNRECOVERABLE_EVIDENCE') unrecoverable++;
    else if (classification === 'REVIEW_REQUIRED') reviewRequired++;
    else if (classification === 'INVALID_GEOMETRY_DRIFT') {
      // already counted
    } else if (classification === 'REAL_EVIDENCE_VALID') realValid++;

    const out = {
      mountainId: mid,
      mountainOsmId: entry.mountainOsmId,
      requestedStart: artifact?.start.requested ?? null,
      recoveredCandidate: startCandidate
        ? { osmType: startCandidate.osmType, osmId: startCandidate.osmId, kind: startCandidate.kind, coordinate: [startCandidate.lon, startCandidate.lat], name: startCandidate.name, tags: startCandidate.tags }
        : null,
      recoverReason,
      realAccessEvidence,
      summitEvidence: {
        requested: artifact?.summitSnap.requested ?? null,
        snapped: artifact?.summitSnap.snapped ?? null,
        actualSnapDistanceM,
        terminalDistanceM,
        tier,
        summitReason,
      },
      graphId: meta.graphId,
      pbfSha256: meta.pbfSha256,
      candidateIndexVersion: candidateIndex.version,
      geometryHash: artifact?.geometryHash ?? null,
      recomputedGeometryHash: geojson ? geometryHash(geojson.features[0].geometry.coordinates as [number, number][]) : null,
      geometryPreserved,
      classification,
    };
    await writeFile(join(OUT_BASE, `${mid}.json`), JSON.stringify(out, null, 2) + '\n', 'utf8');
  }

  // Summary
  const summary = {
    generatedAt: new Date().toISOString(),
    total: ready.length,
    pbfSha256: PBF_SHA,
    graphId: meta.graphId,
    candidateIndexVersion: candidateIndex.version,
    counts: {
      REAL_EVIDENCE_VALID: realValid,
      REVIEW_REQUIRED: reviewRequired,
      UNRECOVERABLE_EVIDENCE: unrecoverable,
      INVALID_GEOMETRY_DRIFT: invalidGeometry,
    },
    tierCounts: { DIRECT: direct, EXTENDED: extended, OVER_50: over50 },
    baseAccess: { noWitnessCount, ambiguousStartCount },
    geometryPreservedCount,
    note: 'REAL_EVIDENCE_VALID requires full BaseAccessNetwork witness from frozen PBF OSM topology (not yet extracted for these 573). Current reconstruction recovers real candidate identity and real summit distance but marks witness as UNRECOVERABLE until block-graph extraction is performed. This is fail-closed and does not use fabricated evidence.',
  };
  await writeFile(join('identity-repair/provenance-integrity', 'reconstructed-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/routes/graphhopper/reconstruct-evidence.ts')) {
  reconstruct().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
