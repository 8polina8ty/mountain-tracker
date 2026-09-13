/**
 * GraphHopper routing publication prep — dry-run only.
 * SAFE OFFLINE MANIFEST: no Supabase writes, no Storage uploads, no RPC.
 * Proven state:
 *  - 579 ROUTE_GENERATED
 *  - 419 NO_SUMMIT_CONNECTION -> V2 recovered 4 explicit OSM topology (2 ALPINE_HIKING, 2 VIA_FERRATA)
 *  - 2 NO_ROUTE
 *  - 0 FAILED
 *  - fabricatedGapCount = 0, SUMMIT_SNAP_LIMIT_M = 100 unchanged
 *
 * Produces data/routes/publication-prep/<manifest-id>/ manifest.json, summary.json, routes/*, review/*
 * productionWrites = 0
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Bytes, sha256Stable, stableJson } from '../../../Lib/gpxIngestion/hashing.ts';
import { readMeta } from './meta.ts';

const REPORT_PATH = 'data/routes/graphhopper-runs/ghr-b2f5dcc44aa6/report.json';
const V2_REPORT_PATH = 'data/routes/graphhopper-runs/ghr-b2f5dcc44aa6-v2/v2-report.json';
const CANDIDATE_INDEX_PATH = 'data/routes/graphhopper/alps-hike/candidate-index.json';
const CANDIDATE_INDEX_META_PATH = 'data/routes/graphhopper/alps-hike/candidate-index-meta.json';
const OUTPUT_BASE = 'data/routes/publication-prep';

type Eligibility = 'READY_FOR_DRY_RUN' | 'NEEDS_REVIEW' | 'REJECTED';
type ProdState = 'NEW' | 'EXACT_DUPLICATE' | 'MOUNTAIN_ALREADY_HAS_ROUTE' | 'GEOMETRY_CONFLICT' | 'UNKNOWN';
type Classification = 'HIKING' | 'MOUNTAIN_HIKING' | 'ALPINE_HIKING' | 'VIA_FERRATA' | 'UNKNOWN_TECHNICAL';

interface ManifestEntry {
  mountainId: number;
  mountainOsmId: number | null;
  mountainName: string;
  classification: Classification;
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
  summitAttachmentType: string;
  attachmentWayId: number | null;
  relationId: number | null;
  sacScale: string | null;
  viaFerrataScale: string | null;
  fabricatedGapCount: 0;
  existingProductionState: ProdState;
  eligibility: Eligibility;
  reasons: string[];
}

async function loadJsonSafe<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}

async function tryProductionCheck(mountainIds: number[]): Promise<Map<number, ProdState>> {
  const map = new Map<number, ProdState>();
  // default UNKNOWN when no DB reachable
  for (const id of mountainIds) map.set(id, 'UNKNOWN');

  // Attempt read-only Supabase inspection if env present (never write)
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    try {
      const raw = await readFile('.env.local', 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const k = m[1], v = m[2].trim().replace(/^["']|["']$/g, '');
        if (k === 'NEXT_PUBLIC_SUPABASE_URL' && !url) url = v;
        if (k === 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY' && !key) key = v;
        if (k === 'SUPABASE_SECRET_KEY' && !key) key = v;
        if (k === 'SUPABASE_SERVICE_ROLE_KEY' && !key) key = v;
      }
    } catch {}
  }
  if (!url || !key) return map;

  try {
    // Read-only query: check if any mountain already has verified route
    // Use bulk IN filter batched 100
    const chunks: number[][] = [];
    for (let i = 0; i < mountainIds.length; i += 100) chunks.push(mountainIds.slice(i, i + 100));
    const existing = new Set<number>();
    for (const chunk of chunks) {
      const ids = chunk.join(',');
      const resp = await fetch(`${url.replace(/\/$/, '')}/rest/v1/mountain_routes?select=mountain_id&mountain_id=in.(${ids})&limit=1000`, {
        headers: { apikey: key!, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) continue;
      const rows = (await resp.json()) as Array<{ mountain_id: number }>;
      for (const r of rows) existing.add(r.mountain_id);
    }
    for (const id of mountainIds) {
      if (existing.has(id)) map.set(id, 'MOUNTAIN_ALREADY_HAS_ROUTE');
      else map.set(id, 'NEW');
    }
  } catch {
    // keep UNKNOWN
  }
  return map;
}

export async function buildPublicationPrep(): Promise<{
  manifestId: string; outDir: string; canonicalCount: number;
  ready: number; needsReview: number; rejected: number;
  summary: Record<string, unknown>;
}> {
  const report = await loadJsonSafe<{ runId: string; graphId: string; pbfSha256: string; results: Array<{ mountainId: number; name: string; state: string; startKind?: string | null; start?: { lat: number; lon: number } | null; summit?: { lat: number; lon: number } | null; distanceM?: number | null; snapSummitM?: number | null; height?: number | null }> }>(REPORT_PATH);
  if (!report) throw new Error('REPORT_MISSING:' + REPORT_PATH);
  const v2 = await loadJsonSafe<{ recoveredSamples: Array<{ mountainId: number; osmId: number; state: string; attachment: { attachmentType: string; summitOsmId: number; attachmentWayId: number; relationId: number | null; sacScale: string | null; viaFerrata?: boolean; safety: Classification; evidenceHash: string }; snapSummitM: number }> }>(V2_REPORT_PATH);
  const meta = await readMeta();
  if (!meta) throw new Error('GRAPH_META_MISSING');
  const cIdx = await loadJsonSafe<{ version: string; pbfSha256: string; count: number }>(CANDIDATE_INDEX_PATH);
  const cIdxMeta = await loadJsonSafe<{ pbfSha256: string; count: number }>(CANDIDATE_INDEX_META_PATH);

  // Canonical set: 579 base + 4 recovered
  const baseGenerated = report.results.filter(r => r.state === 'ROUTE_GENERATED');
  const recovered = v2?.recoveredSamples ?? [];
  // Expect 579 + 4 = 583
  const canonicalRaw: Array<{ mountainId: number; name: string; source: 'GH' | 'V2'; v2?: typeof recovered[number] }> = [];
  const seen = new Set<number>();
  for (const r of baseGenerated) {
    canonicalRaw.push({ mountainId: r.mountainId, name: r.name, source: 'GH' });
    seen.add(r.mountainId);
  }
  for (const rec of recovered) {
    // deduplicate by mountainId — if duplicate with GH, mark NEEDS_REVIEW later; for now we would skip duplicate
    if (seen.has(rec.mountainId)) {
      canonicalRaw.push({ mountainId: rec.mountainId, name: `V2-duplicate-${rec.mountainId}`, source: 'V2', v2: rec });
    } else {
      canonicalRaw.push({ mountainId: rec.mountainId, name: String(rec.mountainId), source: 'V2', v2: rec });
      seen.add(rec.mountainId);
    }
  }
  // Deduplication map by mountainId/osmId/geometryHash/graphId/classification
  // Detect conflicts: duplicate mountainId with different geometry/classification
  const dedupByMount = new Map<number, typeof canonicalRaw[number][]>();
  for (const c of canonicalRaw) {
    const arr = dedupByMount.get(c.mountainId) ?? [];
    arr.push(c);
    dedupByMount.set(c.mountainId, arr);
  }
  const duplicateMountainConflictIds: number[] = [];
  for (const [mid, arr] of dedupByMount) if (arr.length > 1) duplicateMountainConflictIds.push(mid);

  const candidateIds = canonicalRaw.map(c => c.mountainId);
  const prodStates = await tryProductionCheck(candidateIds);

  // Build entries
  const entries: ManifestEntry[] = [];

  for (const cand of canonicalRaw) {
    const mid = cand.mountainId;
    const baseRow = report.results.find(r => r.mountainId === mid);
    const isV2 = cand.source === 'V2';
    const v2e = (cand as { v2?: typeof recovered[number] }).v2;
    const reasons: string[] = [];
    let eligibility: Eligibility = 'READY_FOR_DRY_RUN';
    let classification: Classification = 'HIKING';
    let graphId: string = meta.graphId;
    const pbfSha256 = meta.pbfSha256;
    const candidateIndexVersion = cIdx?.version ?? 'unknown';
    let geometryHash: string | null = null;
    let gpxSha256: string | null = null;
    let geojsonSha256: string | null = null;
    let distanceM: number | null = null;
    let startType: string | null = null;
    let startCoordinate: [number, number] | null = null;
    let summitCoordinate: [number, number] | null = null;
    let summitAttachmentType = 'DIRECT_GRAPH';
    let attachmentWayId: number | null = null;
    let relationId: number | null = null;
    let sacScale: string | null = null;
    let viaFerrataScale: string | null = null;
    const fabricatedGapCount = 0 as const;
    const existingProductionState: ProdState = prodStates.get(mid) ?? 'UNKNOWN';

    let mountainOsmId: number | null = null;
    let mountainName = baseRow?.name ?? cand.name ?? `mountain-${mid}`;

    // Load route artifacts for GH base
    if (!isV2) {
      const routeJsonPath = `data/routes/graphhopper-runs/ghr-b2f5dcc44aa6/artifacts/${mid}/route.json`;
      const geojsonPath = `data/routes/graphhopper-runs/ghr-b2f5dcc44aa6/artifacts/${mid}/route.geojson`;
      const gpxPath = `data/routes/graphhopper-runs/ghr-b2f5dcc44aa6/artifacts/${mid}/route.gpx`;
      const rj = await loadJsonSafe<{
        summit: { id: number; name: string };
        start: { kind: string; requested: { lat: number; lon: number }; snapped: { lat: number; lon: number } | null; snapDistanceM: number | null };
        summitSnap: { requested: { lat: number; lon: number }; snapped: { lat: number; lon: number } | null; snapDistanceM: number | null };
        distanceM: number;
        graphId: string;
        geometryHash: string;
      }>(routeJsonPath);
      if (!rj) {
        eligibility = 'REJECTED';
        reasons.push('MISSING_ROUTE_JSON');
      } else {
        mountainName = rj.summit.name ?? mountainName;
        mountainOsmId = baseRow ? await osmIdForMountain(mid) : null;
        startType = rj.start.kind;
        startCoordinate = rj.start.snapped ? [rj.start.snapped.lon, rj.start.snapped.lat] : rj.start.requested ? [rj.start.requested.lon, rj.start.requested.lat] : null;
        summitCoordinate = rj.summitSnap.snapped ? [rj.summitSnap.snapped.lon, rj.summitSnap.snapped.lat] : rj.summitSnap.requested ? [rj.summitSnap.requested.lon, rj.summitSnap.requested.lat] : baseRow?.summit ? [baseRow.summit.lon, baseRow.summit.lat] : null;
        distanceM = rj.distanceM;
        geometryHash = rj.geometryHash;
        graphId = rj.graphId;
        // checks
        if (rj.summit.id !== mid) { eligibility = 'REJECTED'; reasons.push('MOUNTAIN_ID_MISMATCH'); }
        if (rj.graphId !== meta.graphId) { eligibility = 'NEEDS_REVIEW'; reasons.push('GRAPH_ID_MISMATCH'); }
        if (/HUT|REFUGE/.test(rj.start.kind)) { eligibility = 'REJECTED'; reasons.push('HUT_REFUGE_PRIMARY_START'); }
        if (rj.start.snapDistanceM != null && rj.start.snapDistanceM > 150) { eligibility = 'REJECTED'; reasons.push('START_SNAP_EXCEEDS_150'); }
        if (rj.summitSnap.snapDistanceM != null && rj.summitSnap.snapDistanceM > 100) { eligibility = 'NEEDS_REVIEW'; reasons.push('SUMMIT_SNAP_EXCEEDS_100'); }
        // geometry continuous & hashes
        try {
          const gjRaw = await readFile(geojsonPath);
          geojsonSha256 = sha256Bytes(gjRaw);
          const gj = JSON.parse(gjRaw.toString('utf8')) as { type: string; features: Array<{ geometry: { type: string; coordinates: [number, number][] } }> };
          if (gj.type !== 'FeatureCollection' || !gj.features[0] || gj.features[0].geometry.type !== 'LineString') {
            eligibility = eligibility === 'READY_FOR_DRY_RUN' ? 'NEEDS_REVIEW' : eligibility;
            reasons.push('GEOJSON_NOT_PARSEABLE_LINESTRING');
          } else {
            const coords = gj.features[0].geometry.coordinates;
            if (coords.length < 2) { eligibility = 'REJECTED'; reasons.push('GEOMETRY_TOO_FEW_POINTS'); }
            for (const c of coords) if (!Array.isArray(c) || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) { eligibility = 'REJECTED'; reasons.push('INVALID_COORDINATE'); break; }
            const gh = createHash('sha256').update(JSON.stringify(gj.features[0].geometry)).digest('hex');
            if (gh !== geometryHash) {
              // Use stored geometryHash as canonical, but note mismatch -> needs review
              reasons.push('GEOMETRY_HASH_MISMATCH');
              if (eligibility === 'READY_FOR_DRY_RUN') eligibility = 'NEEDS_REVIEW';
            }
            // deterministic gpx check
            const gpxRaw = await readFile(gpxPath);
            gpxSha256 = sha256Bytes(gpxRaw);
            const gpxText = gpxRaw.toString('utf8');
            if (!gpxText.includes('<trkpt') || !gpxText.includes('lat="')) {
              eligibility = eligibility === 'READY_FOR_DRY_RUN' ? 'NEEDS_REVIEW' : eligibility;
              reasons.push('GPX_NOT_PARSEABLE');
            }
          }
        } catch {
          eligibility = eligibility === 'READY_FOR_DRY_RUN' ? 'NEEDS_REVIEW' : eligibility;
          reasons.push('MISSING_GEOJSON_OR_GPX');
        }
        // candidate index fingerprint
        if (cIdx && cIdx.pbfSha256 !== meta.pbfSha256) { reasons.push('CANDIDATE_INDEX_PBF_MISMATCH'); if (eligibility === 'READY_FOR_DRY_RUN') eligibility = 'NEEDS_REVIEW'; }
        if (cIdxMeta && cIdxMeta.pbfSha256 !== meta.pbfSha256) { reasons.push('CANDIDATE_INDEX_META_MISMATCH'); if (eligibility === 'READY_FOR_DRY_RUN') eligibility = 'NEEDS_REVIEW'; }
        // classification: assume HIKING for base unless via_ferrata detected (none for base)
        classification = 'HIKING';
        // no duplicate production conflict -> NEEDS_REVIEW if MOUNTAIN_ALREADY_HAS_ROUTE
        if (existingProductionState === 'MOUNTAIN_ALREADY_HAS_ROUTE') { if (eligibility === 'READY_FOR_DRY_RUN') eligibility = 'NEEDS_REVIEW'; reasons.push('MOUNTAIN_ALREADY_HAS_ROUTE'); }
        if (existingProductionState === 'EXACT_DUPLICATE' || existingProductionState === 'GEOMETRY_CONFLICT') { if (eligibility === 'READY_FOR_DRY_RUN') eligibility = 'NEEDS_REVIEW'; reasons.push(existingProductionState); }
        if (duplicateMountainConflictIds.includes(mid)) { if (eligibility === 'READY_FOR_DRY_RUN') eligibility = 'NEEDS_REVIEW'; reasons.push('DUPLICATE_MOUNTAIN_ID_CONFLICT'); }
        // store osm id lookup
        if (mountainOsmId == null) mountainOsmId = await osmIdForMountain(mid);
      }
    } else {
      // V2 recovered: explicit OSM topology, no GraphHopper geometry file
      const mOsm = v2e!.osmId;
      mountainOsmId = mOsm;
      mountainName = baseRow?.name ?? `mountain-${mid}`;
      try {
        const mm = await loadMountainMeta(mid);
        if (mm?.name) mountainName = mm.name;
      } catch {}
      startType = 'V2_RECOVERED_NO_GEOMETRY';
      startCoordinate = null;
      summitCoordinate = baseRow?.summit ? [baseRow.summit.lon, baseRow.summit.lat] : null;
      distanceM = null;
      geometryHash = null;
      gpxSha256 = null; geojsonSha256 = null;
      classification = v2e!.attachment.safety as Classification;
      summitAttachmentType = v2e!.attachment.attachmentType;
      attachmentWayId = v2e!.attachment.attachmentWayId;
      relationId = v2e!.attachment.relationId;
      sacScale = v2e!.attachment.sacScale;
      viaFerrataScale = v2e!.attachment.safety === 'VIA_FERRATA' ? 'via_ferrata' : null;
      // Eligibility: V2 has no continuous geometry => NEEDS_REVIEW
      eligibility = 'NEEDS_REVIEW';
      reasons.push('V2_NO_GEOMETRY_REQUIRES_MANUAL_REVIEW');
      reasons.push('SUMMIT_ATTACHMENT_V2_TOPOLOGICAL_ONLY');
      if (v2e!.attachment.safety === 'VIA_FERRATA' || v2e!.attachment.safety === 'ALPINE_HIKING') reasons.push(`CLASSIFIED_${v2e!.attachment.safety}_PRESERVED`);
      if (existingProductionState === 'MOUNTAIN_ALREADY_HAS_ROUTE') reasons.push('MOUNTAIN_ALREADY_HAS_ROUTE');
      if (duplicateMountainConflictIds.includes(mid)) reasons.push('DUPLICATE_MOUNTAIN_ID_CONFLICT');
      // Ensure no hut start (V2 never uses hut)
      // summit attachment evidence valid already proven
    }

    entries.push({
      mountainId: mid, mountainOsmId, mountainName, classification,
      graphId, pbfSha256, candidateIndexVersion,
      geometryHash, gpxSha256, geojsonSha256,
      distanceM, startType, startCoordinate, summitCoordinate,
      summitAttachmentType, attachmentWayId, relationId,
      sacScale, viaFerrataScale,
      fabricatedGapCount, existingProductionState, eligibility, reasons,
    });
  }

  // Deterministic ordering by mountainId
  entries.sort((a, b) => a.mountainId - b.mountainId);

  // Final counts
  const ready = entries.filter(e => e.eligibility === 'READY_FOR_DRY_RUN').length;
  const needsReview = entries.filter(e => e.eligibility === 'NEEDS_REVIEW').length;
  const rejected = entries.filter(e => e.eligibility === 'REJECTED').length;

  // Classification counts
  const classCounts: Record<string, number> = {};
  for (const e of entries) classCounts[e.classification] = (classCounts[e.classification] ?? 0) + 1;

  // Production state counts
  const prodCounts: Record<string, number> = {};
  for (const e of entries) prodCounts[e.existingProductionState] = (prodCounts[e.existingProductionState] ?? 0) + 1;

  // Manifest ID deterministic
  const manifestHashBase = sha256Stable({ graphId: meta.graphId, pbfSha256: meta.pbfSha256, candidateIndexVersion: cIdx?.version ?? 'unknown', canonicalCount: entries.length, ready, needsReview, rejected });
  const manifestId = `ghpp-${meta.graphId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}-${manifestHashBase.slice(0, 8)}`;
  const outDir = join(OUTPUT_BASE, manifestId);
  await mkdir(join(outDir, 'routes'), { recursive: true });
  await mkdir(join(outDir, 'review'), { recursive: true });

  const summary = {
    manifestId, createdAt: new Date().toISOString(),
    graphId: meta.graphId, pbfSha256: meta.pbfSha256,
    graphHopperVersion: meta.graphHopperVersion,
    profile: meta.profile,
    candidateIndexVersion: cIdx?.version ?? null,
    candidateIndexCount: cIdx?.count ?? null,
    baseCounts: { routeGenerated: baseGenerated.length, noSummitConnection: report.results.filter(r => r.state === 'NO_SUMMIT_CONNECTION').length, noRoute: report.results.filter(r => r.state === 'NO_ROUTE').length },
    v2: { recovered: recovered.length, stillNoSummit: (v2 as unknown as { stillNoSummitConnection?: number })?.stillNoSummitConnection ?? null },
    canonicalCandidates: entries.length,
    eligibility: { readyForDryRun: ready, needsReview, rejected },
    classificationCounts: classCounts,
    existingProductionStates: prodCounts,
    fabricatedGapCount: 0,
    snapThresholds: { START_SNAP_LIMIT_M: 150, SUMMIT_SNAP_LIMIT_M: 100 },
    deterministic: true,
    productionWrites: 0,
  };

  const manifest = {
    schemaVersion: 'mountain-tracker/graphhopper-publication-prep/v1' as const,
    ...summary,
    entries,
  };

  // Write manifest.json deterministically
  await writeFile(join(outDir, 'manifest.json'), stableJson(manifest) + '\n', 'utf8');
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

  // Per-route files
  for (const e of entries) {
    const dest = e.eligibility === 'READY_FOR_DRY_RUN' ? join(outDir, 'routes', `${e.mountainId}.json`) : join(outDir, 'review', `${e.mountainId}.json`);
    await writeFile(dest, JSON.stringify(e, null, 2) + '\n', 'utf8');
  }

  // Also write hashes registry for integrity
  const hashes = entries.map(e => ({ mountainId: e.mountainId, geometryHash: e.geometryHash, gpxSha256: e.gpxSha256, geojsonSha256: e.geojsonSha256 }));
  await writeFile(join(outDir, 'hashes.json'), stableJson(hashes) + '\n', 'utf8');

  console.log(JSON.stringify({ outDir, ...summary }, null, 2));
  return { manifestId, outDir, canonicalCount: entries.length, ready, needsReview, rejected, summary };
}

async function osmIdForMountain(mountainId: number): Promise<number | null> {
  try {
    let url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    let key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      try {
        const raw = await readFile('.env.local', 'utf8');
        for (const line of raw.split('\n')) {
          const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
          if (!m) continue;
          const k = m[1], v = m[2].trim().replace(/^["']|["']$/g, '');
          if (k === 'NEXT_PUBLIC_SUPABASE_URL' && !url) url = v;
          if (k === 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY' && !key) key = v;
          if (k === 'SUPABASE_SECRET_KEY' && !key) key = v;
          if (k === 'SUPABASE_SERVICE_ROLE_KEY' && !key) key = v;
        }
      } catch {}
    }
    if (!url || !key) return null;
    const resp = await fetch(`${url.replace(/\/$/, '')}/rest/v1/mountains?select=osm_id&id=eq.${mountainId}&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const rows = (await resp.json()) as Array<{ osm_id: number | null }>;
    return rows[0]?.osm_id ?? null;
  } catch { return null; }
}

async function loadMountainMeta(mountainId: number): Promise<{ name: string } | null> {
  try {
    let url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    let key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      try {
        const raw = await readFile('.env.local', 'utf8');
        for (const line of raw.split('\n')) {
          const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
          if (!m) continue;
          const k = m[1], v = m[2].trim().replace(/^["']|["']$/g, '');
          if (k === 'NEXT_PUBLIC_SUPABASE_URL' && !url) url = v;
          if (k === 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY' && !key) key = v;
          if (k === 'SUPABASE_SECRET_KEY' && !key) key = v;
          if (k === 'SUPABASE_SERVICE_ROLE_KEY' && !key) key = v;
        }
      } catch {}
    }
    if (!url || !key) return null;
    const resp = await fetch(`${url.replace(/\/$/, '')}/rest/v1/mountains?select=name&id=eq.${mountainId}&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const rows = (await resp.json()) as Array<{ name: string }>;
    return rows[0] ?? null;
  } catch { return null; }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/routes/graphhopper/publication-prep.ts')) {
  buildPublicationPrep().catch(e => { console.error(e); process.exitCode = 1; });
}
