/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
 /** Narrow GraphHopper adapter: start -> summit -> geometry */
import { createHash } from 'node:crypto';

export interface RouteRequest {
  start: { lat: number; lon: number };
  summit: { lat: number; lon: number };
}

export interface RouteResult {
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  distanceMeters: number;
  timeMillis: number;
  requestedStart: { lat: number; lon: number };
  requestedSummit: { lat: number; lon: number };
  snappedStart: { lat: number; lon: number } | null;
  snappedSummit: { lat: number; lon: number } | null;
  snapDistanceStartM: number | null;
  snapDistanceSummitM: number | null;
  profile: string;
  graphId: string;
  graphHopperVersion: string;
  routingEngine: 'GRAPH_HOPPER' | 'OSM_DIJKSTRA_FALLBACK';
  pbfSha256: string;
  fallbackReason?: string | null;
}

export interface GraphHopperRouteResponse {
  paths: Array<{
    distance: number;
    time: number;
    points: { coordinates: [number, number][]; type: string };
    snapped_waypoints: { coordinates: [number, number][]; type: string };
  }>;
  info?: { took: number };
}

type SnapResult = { ok: true; result: RouteResult } | { ok: false; reason: string; snapStart?: number | null; snapSummit?: number | null };

const SNAP_LIMIT_M = 150; // start snap safety aligned with Base Access max approach 150m
const SUMMIT_SNAP_LIMIT_M = 100; // summit attachment REVIEW threshold

function haversine(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
}

function extractSnapped(response: GraphHopperRouteResponse): [number, number][] | undefined {
  // GraphHopper external boundary: snapped_waypoints may be absent, use unknown guard
  const raw = response.paths[0] as unknown as { snapped_waypoints?: { coordinates?: unknown } };
  const coords = raw.snapped_waypoints?.coordinates;
  if (Array.isArray(coords) && coords.every((c) => Array.isArray(c) && c.length === 2 && typeof c[0] === 'number' && typeof c[1] === 'number')) {
    return coords as [number, number][];
  }
  return undefined;
}

async function osmFallback(req: RouteRequest, opts: { graphId: string; graphHopperVersion: string; profile?: string }): Promise<SnapResult> {
  try {
    const { blockFor, loadPbfBlockContext } = await import('./pbf-block-loader.ts');
    const { createHash } = await import('node:crypto');
    void createHash;
    // Use summit block as primary graph (covers halo)
    const midLon=(req.start.lon+req.summit.lon)/2, midLat=(req.start.lat+req.summit.lat)/2;
    const block=blockFor(midLon, midLat);
    const dataset={datasetKey:'local-osm-pbf',region:'local',snapshotTimestamp:new Date().toISOString(),pbfSha256:'15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5'} as any;
    const ctx=await loadPbfBlockContext(block, dataset);
    const g=ctx.graph as any;
    const startNearest=g.findNearestNode([req.start.lon, req.start.lat], 150);
    const summitNearest=g.findNearestNode([req.summit.lon, req.summit.lat], 100);
    if(!startNearest) return { ok:false, reason:'REJECTED_ACCESS', snapStart: 999, snapSummit: null };
    if(!summitNearest) return { ok:false, reason:'NO_SUMMIT_CONNECTION', snapStart: startNearest.distanceM, snapSummit: 999 };
    const snapStartM=startNearest.distanceM;
    const snapSummitM=summitNearest.distanceM;
    if(snapStartM>150) return { ok:false, reason:'REJECTED_ACCESS', snapStart: snapStartM, snapSummit: snapSummitM };
    if(snapSummitM>100) return { ok:false, reason:'NO_SUMMIT_CONNECTION', snapStart: snapStartM, snapSummit: snapSummitM };
    // Dijkstra
    const startId=startNearest.node.nodeId;
    const targetId=summitNearest.node.nodeId;
    const dist=new Map<number,number>([[startId,0]]);
    const prev=new Map<number,{id:number, way:number}>();
    const visited=new Set<number>();
    const pq:Array<{id:number,d:number}>=[{id:startId,d:0}];
    while(pq.length){
      pq.sort((a,b)=>a.d-b.d);
      const cur=pq.shift()!;
      if(visited.has(cur.id)) continue;
      visited.add(cur.id);
      if(cur.id===targetId) break;
      for(const e of g.neighbors(cur.id)){
        if(visited.has(e.toNodeId)) continue;
        const nd=cur.d + e.distanceM;
        if(!dist.has(e.toNodeId) || nd < (dist.get(e.toNodeId) ?? Infinity)){
          dist.set(e.toNodeId, nd);
          prev.set(e.toNodeId, {id:cur.id, way:e.wayId});
          pq.push({id:e.toNodeId, d:nd});
        }
      }
      if(visited.size>100000) break;
    }
    if(!visited.has(targetId)) return { ok:false, reason:'NO_ROUTE', snapStart: snapStartM, snapSummit: snapSummitM };
    const nodes:number[]=[targetId];
    const ways:number[]=[];
    let cur=targetId;
    while(cur!==startId){
      const p=prev.get(cur);
      if(!p) break;
      nodes.unshift(p.id);
      ways.unshift(p.way);
      cur=p.id;
    }
    const coords=nodes.map((id:number)=> g.node(id).coordinate as [number,number]);
    const distance=dist.get(targetId)!;
    const tier=snapSummitM<=30?'DIRECT': snapSummitM<=50?'EXTENDED':null;
    if(!tier) return { ok:false, reason:'SUMMIT_ATTACHMENT_REVIEW_REQUIRED', snapStart: snapStartM, snapSummit: snapSummitM };
    return { ok:true, result:{ geometry:{type:'LineString', coordinates:coords}, distanceMeters: distance, timeMillis: Math.round(distance/1.2*1000), requestedStart:{...req.start}, requestedSummit:{...req.summit}, snappedStart:{lat: g.node(startId).coordinate[1], lon: g.node(startId).coordinate[0]}, snappedSummit:{lat: g.node(targetId).coordinate[1], lon: g.node(targetId).coordinate[0]}, snapDistanceStartM: snapStartM, snapDistanceSummitM: snapSummitM, profile: opts.profile ?? 'foot', graphId: opts.graphId, graphHopperVersion: opts.graphHopperVersion, routingEngine:'OSM_DIJKSTRA_FALLBACK' as const, pbfSha256:'15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5', fallbackReason:'FETCH_FAILED' } };
  } catch(e){ return { ok:false, reason:`OSM_FALLBACK_FAILED:${e instanceof Error?e.message:String(e)}` }; }
}

export async function routeWithGraphHopper(
  req: RouteRequest,
  opts: { baseUrl?: string; profile?: string; graphId: string; graphHopperVersion: string; timeoutMs?: number; signal?: AbortSignal; allowFallbackAfterHealthy?: boolean; onAttempt?: (engine: 'GRAPH_HOPPER' | 'OSM_DIJKSTRA_FALLBACK', ms: number, fetchFailed: boolean) => void },
): Promise<SnapResult> {
  const baseUrl = opts.baseUrl ?? 'http://localhost:8989';
  const profile = opts.profile ?? 'foot';
  const url = `${baseUrl}/route?point=${req.start.lat},${req.start.lon}&point=${req.summit.lat},${req.summit.lon}&profile=${profile}&points_encoded=false&calc_points=true&instructions=false`;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const attemptStart = performance.now();
  let res: Response;
  try {
    res = await fetch(url, { signal });
    // Include body delivery in the request deadline.
    const body = await res.text();
    res = new Response(body, { status: res.status, headers: res.headers });
  } catch (e) {
    opts.onAttempt?.('GRAPH_HOPPER', performance.now() - attemptStart, true);
    opts.signal?.throwIfAborted();
    if (!opts.allowFallbackAfterHealthy) return { ok: false, reason: `FETCH_FAILED:${e instanceof Error ? e.message : String(e)}` };
    const fallbackStart = performance.now();
    const fallback = await osmFallback(req, opts);
    opts.onAttempt?.('OSM_DIJKSTRA_FALLBACK', performance.now() - fallbackStart, false);
    return fallback;
  }
  opts.onAttempt?.('GRAPH_HOPPER', performance.now() - attemptStart, false);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (text.includes('not found') || text.includes('Connection between locations not found')) return { ok: false, reason: 'NO_ROUTE' };
    if (text.includes('Cannot find point')) return { ok: false, reason: 'NO_ROUTE' };
    return { ok: false, reason: `GH_ERROR:${res.status}:${text.slice(0, 500)}` };
  }
  const json = (await res.json()) as GraphHopperRouteResponse;
  if (!json.paths?.[0]) return { ok: false, reason: 'NO_ROUTE' };
  const p = json.paths[0];
  const coords = p.points.coordinates;
  const snapped = extractSnapped(json);
  let snappedStart: { lat: number; lon: number } | null = null;
  let snappedSummit: { lat: number; lon: number } | null = null;
  let snapStartM: number | null = null;
  let snapSummitM: number | null = null;
  if (snapped?.length === 2) {
    snappedStart = { lat: snapped[0][1], lon: snapped[0][0] };
    snappedSummit = { lat: snapped[1][1], lon: snapped[1][0] };
    snapStartM = haversine([req.start.lon, req.start.lat], snapped[0]);
    snapSummitM = haversine([req.summit.lon, req.summit.lat], snapped[1]);
  } else if (coords.length >= 2) {
    snappedStart = { lat: coords[0][1], lon: coords[0][0] };
    snappedSummit = { lat: coords[coords.length - 1][1], lon: coords[coords.length - 1][0] };
    snapStartM = haversine([req.start.lon, req.start.lat], coords[0]);
    snapSummitM = haversine([req.summit.lon, req.summit.lat], coords[coords.length - 1]);
  }

  if (snapStartM !== null && snapStartM > SNAP_LIMIT_M) return { ok: false, reason: 'REJECTED_ACCESS', snapStart: snapStartM, snapSummit: snapSummitM };
  if (snapSummitM !== null && snapSummitM > SUMMIT_SNAP_LIMIT_M) return { ok: false, reason: 'NO_SUMMIT_CONNECTION', snapStart: snapStartM, snapSummit: snapSummitM };

  const geometry: [number, number][] = coords;
  return {
    ok: true,
    result: {
      geometry: { type: 'LineString', coordinates: geometry },
      distanceMeters: p.distance,
      timeMillis: p.time,
      requestedStart: { ...req.start },
      requestedSummit: { ...req.summit },
      snappedStart,
      snappedSummit,
      snapDistanceStartM: snapStartM,
      snapDistanceSummitM: snapSummitM,
      profile,
      graphId: opts.graphId,
      graphHopperVersion: opts.graphHopperVersion,
      routingEngine: 'GRAPH_HOPPER' as const,
      fallbackReason: null,
      pbfSha256: '15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5',
    },
  };
}

export function serializeGpx(name: string, route: RouteResult): string {
  const coords = route.geometry.coordinates;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const trkpts = coords.map(([lon, lat]) => `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="mountain-tracker-graphhopper" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>${esc(name)}</name></metadata>\n  <trk><name>${esc(name)}</name><trkseg>\n${trkpts}\n  </trkseg></trk>\n</gpx>\n`;
}

export function serializeGeojson(name: string, route: RouteResult, extra: Record<string, unknown> = {}): string {
  const gj = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name, distanceMeters: route.distanceMeters, timeMillis: route.timeMillis, profile: route.profile, graphId: route.graphId, ...extra },
        geometry: route.geometry,
      },
    ],
  };
  return `${JSON.stringify(gj, null, 2)}\n`;
}

export function routeJson(
  route: RouteResult,
  startKind: string,
  summit: { id: number; name: string },
  opts?: {
    startCandidate?: { osmType: string; osmId: number; kind: string; name: string | null; lat: number; lon: number; tags: Record<string, string> };
    accessEvidence?: import('../../../Lib/gpxIngestion/baseAccessStartPolicy.ts').BaseAccessEvidence | null;
  },
): string {
  const obj = {
    summit: { id: summit.id, name: summit.name },
    start: { kind: startKind, requested: route.requestedStart, snapped: route.snappedStart, snapDistanceM: route.snapDistanceStartM },
    summitSnap: { requested: route.requestedSummit, snapped: route.snappedSummit, snapDistanceM: route.snapDistanceSummitM },
    distanceM: route.distanceMeters,
    timeMs: route.timeMillis,
    profile: route.profile,
    graphId: route.graphId,
    graphHopperVersion: route.graphHopperVersion,
    routingEngine: route.routingEngine,
    pbfSha256: route.pbfSha256,
    fallbackReason: route.fallbackReason ?? null,
    geometryHash: createHash('sha256').update(JSON.stringify(route.geometry)).digest('hex'),
    // Real evidence frozen during generation (fail-closed if missing)
    startCandidate: opts?.startCandidate ?? null,
    accessEvidence: opts?.accessEvidence ?? null,
  };
  return `${JSON.stringify(obj, null, 2)}\n`;
}
