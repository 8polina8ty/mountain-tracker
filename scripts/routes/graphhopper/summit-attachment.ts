/**
 * Summit Attachment V2 — conservative topological OSM evidence.
 * - No fabricated straight-line connectors
 * - No global snap limit increase (100m stays)
 * - Only recovers when explicit shared-node/way relation exists
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export type AttachmentType = 'DIRECT_GRAPH' | 'OSM_SUMMIT_WAY' | 'OSM_RELATION' | 'VIA_FERRATA' | 'NONE';
export type SafetyClass = 'HIKING' | 'MOUNTAIN_HIKING' | 'ALPINE_HIKING' | 'VIA_FERRATA' | 'UNKNOWN_TECHNICAL' | 'REJECTED';

// Keep global safety limits unchanged
export const START_SNAP_LIMIT_M = 150;
export const SUMMIT_SNAP_LIMIT_M = 100;

export interface SummitIdentity {
  mountainId: number;
  osmId: number | null;
  dbCoordinate: { lat: number; lon: number };
  osmPeakCoordinate: { lat: number; lon: number } | null;
  driftM: number | null;
  isAuthoritative: boolean;
}

export interface SummitWayEvidence {
  summitOsmId: number;
  attachmentWayId: number;
  relationId: number | null;
  tags: Record<string, string>;
  sacScale: string | null;
  highway: string | null;
  access: string | null;
  viaFerrata: boolean;
}

export interface AttachmentEvidence {
  attachmentType: AttachmentType;
  summitOsmId: number | null;
  attachmentWayId: number | null;
  relationId: number | null;
  attachmentDistance: number | null;
  sacScale: string | null;
  highway: string | null;
  access: string | null;
  evidenceHash: string;
  safety: SafetyClass;
}

function haversine(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
}

export function driftMeters(db: { lat: number; lon: number }, osm: { lat: number; lon: number }): number {
  return haversine([db.lon, db.lat], [osm.lon, osm.lat]);
}

// Resolve summit identity: prefer exact OSM natural=peak node when osm_id matches and is unambiguous
export async function resolveSummitIdentity(
  mountain: { id: number; osm_id: number | null; latitude: number; longitude: number },
  peaks: Map<number, { lat: number; lon: number; tags: Record<string, string> }>,
): Promise<SummitIdentity> {
  const db = { lat: mountain.latitude, lon: mountain.longitude };
  const osmId = mountain.osm_id;
  if (osmId != null && peaks.has(osmId)) {
    const osm = peaks.get(osmId)!;
    const d = driftMeters(db, osm);
    const isAuthoritative = d < 100 && osm.tags['natural'] === 'peak';
    return {
      mountainId: mountain.id,
      osmId,
      dbCoordinate: db,
      osmPeakCoordinate: { lat: osm.lat, lon: osm.lon },
      driftM: d,
      isAuthoritative,
    };
  }
  return {
    mountainId: mountain.id,
    osmId,
    dbCoordinate: db,
    osmPeakCoordinate: null,
    driftM: null,
    isAuthoritative: false,
  };
}

export function classifySafety(tags: Record<string, string>): SafetyClass {
  const access = tags['access'];
  const foot = tags['foot'];
  if (access === 'no' || access === 'private' || foot === 'no') return 'REJECTED';
  if (tags['highway'] === 'via_ferrata' || tags['via_ferrata'] === 'yes') return 'VIA_FERRATA';
  const sac = tags['sac_scale'];
  if (sac === 'demanding_alpine_hiking' || sac === 'difficult_alpine_hiking') return 'ALPINE_HIKING';
  if (sac === 'mountain_hiking') return 'MOUNTAIN_HIKING';
  if (sac === 'hiking' || sac === 'alpine_hiking') return 'HIKING';
  // No sac_scale but highway path with trail_visibility bad etc -> unknown
  if (tags['highway'] === 'path' && tags['trail_visibility'] === 'bad') return 'UNKNOWN_TECHNICAL';
  if (tags['highway'] === 'path') return 'HIKING';
  return 'UNKNOWN_TECHNICAL';
}

export function evidenceHashFor(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

// In-memory index of ways that directly contain summit peak node (topological)
export type WayIndex = Map<number, { tags: Record<string, string>; peaks: number[] }>;

export function findSummitWayEvidence(
  summitOsmId: number,
  wayIndex: WayIndex,
): SummitWayEvidence | null {
  for (const [wayId, data] of wayIndex) {
    if (data.peaks.includes(summitOsmId)) {
      const tags = data.tags;
      const access = tags['access'] ?? tags['foot'] ?? null;
      if (access === 'no' || access === 'private' || tags['foot'] === 'no') return null; // REJECTED
      return {
        summitOsmId,
        attachmentWayId: wayId,
        relationId: null,
        tags,
        sacScale: tags['sac_scale'] ?? null,
        highway: tags['highway'] ?? null,
        access,
        viaFerrata: tags['highway'] === 'via_ferrata' || tags['via_ferrata'] === 'yes',
      };
    }
  }
  return null;
}

export function toAttachmentEvidence(
  ev: SummitWayEvidence | null,
  opts: { attachmentType: AttachmentType; distance: number | null },
): AttachmentEvidence {
  if (!ev) {
    return {
      attachmentType: 'NONE',
      summitOsmId: null,
      attachmentWayId: null,
      relationId: null,
      attachmentDistance: null,
      sacScale: null,
      highway: null,
      access: null,
      evidenceHash: evidenceHashFor({ type: 'NONE' }),
      safety: 'REJECTED',
    };
  }
  const safety = classifySafety(ev.tags);
  if (safety === 'REJECTED') {
    return {
      attachmentType: 'NONE',
      summitOsmId: ev.summitOsmId,
      attachmentWayId: ev.attachmentWayId,
      relationId: ev.relationId,
      attachmentDistance: opts.distance,
      sacScale: ev.sacScale,
      highway: ev.highway,
      access: ev.access,
      evidenceHash: evidenceHashFor(ev),
      safety,
    };
  }
  const attType: AttachmentType = ev.viaFerrata ? 'VIA_FERRATA' : ev.relationId ? 'OSM_RELATION' : 'OSM_SUMMIT_WAY';
  return {
    attachmentType: attType,
    summitOsmId: ev.summitOsmId,
    attachmentWayId: ev.attachmentWayId,
    relationId: ev.relationId,
    attachmentDistance: opts.distance,
    sacScale: ev.sacScale,
    highway: ev.highway,
    access: ev.access,
    evidenceHash: evidenceHashFor(ev),
    safety,
  };
}

// Relation-based attachment (future): check if summit way is member of hiking route relation
export function findRelationEvidence(
  wayId: number,
  relations: Array<{ id: number; tags: Record<string, string>; members: Array<[string, number, string]> }>,
): number | null {
  for (const r of relations) {
    for (const [type, ref] of r.members) {
      if (type === 'w' && ref === wayId) return r.id;
    }
  }
  return null;
}

// Load peaks from local PBF-extracted JSON (generated via osmium getid)
export async function loadPeaksFromIdentityJson(path = 'data/routes/graphhopper-runs/ghr-b2f5dcc44aa6/summit-osm-identity.json'): Promise<Map<number, { lat: number; lon: number; tags: Record<string, string> }>> {
  try {
    const raw = await readFile(path, 'utf8');
    const j = JSON.parse(raw) as { peaks: Record<string, { lat: number; lon: number; tags: Record<string, string> }> };
    const m = new Map<number, { lat: number; lon: number; tags: Record<string, string> }>();
    for (const [k, v] of Object.entries(j.peaks)) m.set(Number(k), v);
    return m;
  } catch {
    return new Map();
  }
}

export async function loadWayIndexFromAnalysis(path = 'data/routes/graphhopper-runs/ghr-b2f5dcc44aa6/hiking-ways-analysis.json'): Promise<WayIndex> {
  try {
    const raw = await readFile(path, 'utf8');
    const j = JSON.parse(raw) as { ways_with_peak: Record<string, { tags: Record<string, string>; peaks: number[] }> };
    const m = new Map<number, { tags: Record<string, string>; peaks: number[] }>();
    for (const [k, v] of Object.entries(j.ways_with_peak)) m.set(Number(k), v);
    return m;
  } catch {
    return new Map();
  }
}
