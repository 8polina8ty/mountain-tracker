import { calculateCoordinateDistanceMeters } from './gpxNormalization.ts';
import type { Coordinate } from './types.ts';
import {
  DEFAULT_START_CONTEXT_OPTIONS,
  type FeatureIndex,
  type StartContextOptions,
} from '../../scripts/osm-import/start-context-classifier3.ts';

export const ADAPTIVE_START_FEATURE_INDEX_VERSION =
  'mountain-tracker/adaptive-start-feature-index/v1' as const;

export type AdaptiveStartFeatureKind =
  | 'TRAILHEAD' | 'TRAILHEAD_INFO' | 'PARKING' | 'VILLAGE' | 'HAMLET'
  | 'TRAIN_STATION' | 'HALT' | 'BUS_STOP' | 'ISOLATED_DWELLING' | 'FARM'
  | 'ALPINE_HUT' | 'WILDERNESS_HUT';

export interface AdaptiveStartFeature {
  identity: string;
  objectType: 'node' | 'way' | 'relation';
  osmId: number;
  name: string | null;
  coordinate: Coordinate;
  tags: Record<string, string>;
  kind: AdaptiveStartFeatureKind;
}

type FeatureRecord = FeatureIndex['parking'][number];
type FeatureLayer = keyof FeatureIndex;
const LAYERS: readonly FeatureLayer[] = [
  'alpineHuts', 'wildernessHuts', 'mountainPasses', 'saddles', 'ridges',
  'peaks', 'trailheads', 'trailheadInfo', 'parking', 'villages', 'hamlets',
  'isolatedDwellings', 'farms', 'busStops', 'trainStations', 'halts', 'eleNodes',
];

const CELL_DEGREES = 0.05;
const LONGITUDE_CELLS = 360 / CELL_DEGREES;
const LATITUDE_CELLS = 180 / CELL_DEGREES;
const MAX_QUERY_RADIUS_METERS = 100_000;

function validCoordinate(coordinate: Coordinate | null): coordinate is Coordinate {
  return coordinate !== null && coordinate.length >= 2 &&
    Number.isFinite(coordinate[0]) && Math.abs(coordinate[0]) <= 180 &&
    Number.isFinite(coordinate[1]) && Math.abs(coordinate[1]) <= 90;
}

function textCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tag(tags: Record<string, string>, key: string): string {
  return (tags[key] ?? '').trim().toLowerCase();
}

function kindFromTags(tags: Record<string, string>): AdaptiveStartFeatureKind | null {
  if (tag(tags, 'highway') === 'trailhead') return 'TRAILHEAD';
  if (tag(tags, 'information') === 'guidepost') return 'TRAILHEAD_INFO';
  if (tag(tags, 'amenity') === 'parking') return 'PARKING';
  if (tag(tags, 'place') === 'village') return 'VILLAGE';
  if (tag(tags, 'place') === 'hamlet') return 'HAMLET';
  if (tag(tags, 'railway') === 'station') return 'TRAIN_STATION';
  if (tag(tags, 'railway') === 'halt') return 'HALT';
  if (tag(tags, 'highway') === 'bus_stop') return 'BUS_STOP';
  if (tag(tags, 'place') === 'isolated_dwelling') return 'ISOLATED_DWELLING';
  if (tag(tags, 'place') === 'farm') return 'FARM';
  if (tag(tags, 'tourism') === 'alpine_hut') return 'ALPINE_HUT';
  if (tag(tags, 'tourism') === 'wilderness_hut') return 'WILDERNESS_HUT';
  return null;
}

/** Catalog layers also contain untagged geometry nodes: a layer name is not POI evidence. */
function belongsToLayer(layer: FeatureLayer, record: FeatureRecord): boolean {
  const tags = record.tags;
  switch (layer) {
    case 'alpineHuts': return tag(tags, 'tourism') === 'alpine_hut';
    case 'wildernessHuts': return tag(tags, 'tourism') === 'wilderness_hut';
    case 'mountainPasses': return tag(tags, 'mountain_pass') === 'yes';
    case 'saddles': return tag(tags, 'natural') === 'saddle';
    case 'ridges': return tag(tags, 'natural') === 'ridge';
    case 'peaks': return tag(tags, 'natural') === 'peak';
    case 'trailheads': return tag(tags, 'highway') === 'trailhead';
    case 'trailheadInfo': return tag(tags, 'information') === 'guidepost';
    case 'parking': return tag(tags, 'amenity') === 'parking';
    case 'villages': return tag(tags, 'place') === 'village';
    case 'hamlets': return tag(tags, 'place') === 'hamlet';
    case 'isolatedDwellings': return tag(tags, 'place') === 'isolated_dwelling';
    case 'farms': return tag(tags, 'place') === 'farm';
    case 'busStops': return tag(tags, 'highway') === 'bus_stop';
    case 'trainStations': return tag(tags, 'railway') === 'station';
    case 'halts': return tag(tags, 'railway') === 'halt';
    case 'eleNodes': return tag(tags, 'ele') !== '';
  }
}

function osmId(record: FeatureRecord): number | null {
  const id = Number(String(record.osmid).replace(/^[nwr]/, ''));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function adaptiveStartFeatureFromRecord(record: FeatureRecord): AdaptiveStartFeature | null {
  const id = osmId(record);
  const kind = kindFromTags(record.tags);
  if (!validCoordinate(record.coordinate) || id === null || kind === null ||
    !['node', 'way', 'relation'].includes(record.objectType)) return null;
  return {
    identity: `${record.objectType}:${id}`,
    objectType: record.objectType,
    osmId: id,
    name: record.tags.name?.trim() || record.name?.trim() || null,
    coordinate: [record.coordinate[0], record.coordinate[1]],
    tags: record.tags,
    kind,
  };
}

function emptyFeatureIndex(): FeatureIndex {
  return Object.fromEntries(LAYERS.map(layer => [layer, []])) as unknown as FeatureIndex;
}

function wrapColumn(column: number): number {
  return ((column % LONGITUDE_CELLS) + LONGITUDE_CELLS) % LONGITUDE_CELLS;
}

function rowFor(latitude: number): number {
  return Math.max(0, Math.min(LATITUDE_CELLS - 1, Math.floor((latitude + 90) / CELL_DEGREES)));
}

interface QueryCounters { cellsVisited: number; recordsExamined: number }

/** Fixed geographic buckets bound lookups to nearby cells, including across the dateline. */
class CoordinateGrid<T> {
  private readonly cells = new Map<number, Array<{ coordinate: Coordinate; value: T }>>();

  add(coordinate: Coordinate, value: T): void {
    const column = wrapColumn(Math.floor((coordinate[0] + 180) / CELL_DEGREES));
    const key = rowFor(coordinate[1]) * LONGITUDE_CELLS + column;
    const cell = this.cells.get(key) ?? [];
    cell.push({ coordinate, value });
    this.cells.set(key, cell);
  }

  query(coordinate: Coordinate, radiusMeters: number, counters: QueryCounters): T[] {
    if (!validCoordinate(coordinate) || !Number.isFinite(radiusMeters) ||
      radiusMeters < 0 || radiusMeters > MAX_QUERY_RADIUS_METERS) {
      throw new Error('Adaptive feature query requires valid coordinates and radius in [0, 100000] meters.');
    }
    // Slightly smaller than the shared haversine earth radius: the bounding box is conservative.
    const angularRadius = radiusMeters / 6_371_000 + 1e-12;
    const latitudeRadius = angularRadius * 180 / Math.PI;
    const latitude = coordinate[1] * Math.PI / 180;
    const touchesPole = Math.abs(latitude) + angularRadius >= Math.PI / 2;
    const longitudeRadius = touchesPole ? 180 :
      Math.asin(Math.min(1, Math.sin(angularRadius) / Math.cos(latitude))) * 180 / Math.PI;
    const firstColumn = touchesPole ? 0 : Math.floor((coordinate[0] - longitudeRadius + 180) / CELL_DEGREES);
    const columnCount = touchesPole ? LONGITUDE_CELLS : Math.min(LONGITUDE_CELLS,
      Math.floor((coordinate[0] + longitudeRadius + 180) / CELL_DEGREES) - firstColumn + 1);
    const firstRow = rowFor(coordinate[1] - latitudeRadius);
    const lastRow = rowFor(coordinate[1] + latitudeRadius);
    const result: T[] = [];
    for (let row = firstRow; row <= lastRow; row++) {
      for (let offset = 0; offset < columnCount; offset++) {
        counters.cellsVisited++;
        const cell = this.cells.get(row * LONGITUDE_CELLS + wrapColumn(firstColumn + offset));
        if (!cell) continue;
        for (const entry of cell) {
          counters.recordsExamined++;
          if (calculateCoordinateDistanceMeters(coordinate, entry.coordinate) <= radiusMeters) result.push(entry.value);
        }
      }
    }
    return result;
  }
}

function recordKey(record: FeatureRecord): string {
  return JSON.stringify([record.coordinate, record.name,
    Object.entries(record.tags).sort(([left], [right]) => textCompare(left, right)), record.wayNodeCount]);
}

/** Resolve duplicated catalog rows without depending on source-array order. */
function preferredRecord(left: FeatureRecord, right: FeatureRecord): FeatureRecord {
  const tagDifference = Object.keys(left.tags).length - Object.keys(right.tags).length;
  return tagDifference > 0 || (tagDifference === 0 && recordKey(left) <= recordKey(right)) ? left : right;
}

export interface AdaptiveStartFeatureIndexStats {
  sourceRecordCount: number;
  contextRecordCount: number;
  startFeatureCount: number;
  excludedLayerRecordCount: number;
  startQueryCount: number;
  contextQueryCount: number;
  cellsVisited: number;
  recordsExamined: number;
}

export class AdaptiveStartFeatureIndex {
  readonly schemaVersion = ADAPTIVE_START_FEATURE_INDEX_VERSION;
  private readonly starts = new CoordinateGrid<AdaptiveStartFeature>();
  private readonly context = new CoordinateGrid<{ layer: FeatureLayer; record: FeatureRecord }>();
  private readonly counters: AdaptiveStartFeatureIndexStats = {
    sourceRecordCount: 0, contextRecordCount: 0, startFeatureCount: 0,
    excludedLayerRecordCount: 0, startQueryCount: 0, contextQueryCount: 0,
    cellsVisited: 0, recordsExamined: 0,
  };

  constructor(index: FeatureIndex) {
    const startRecords = new Map<string, FeatureRecord>();
    for (const layer of LAYERS) {
      const records = new Map<string, FeatureRecord>();
      for (const record of index[layer]) {
        this.counters.sourceRecordCount++;
        const id = osmId(record);
        if (!validCoordinate(record.coordinate) || id === null ||
          !['node', 'way', 'relation'].includes(record.objectType) || !belongsToLayer(layer, record)) {
          this.counters.excludedLayerRecordCount++;
          continue;
        }
        const identity = `${record.objectType}:${id}`;
        const prior = records.get(identity);
        records.set(identity, prior ? preferredRecord(prior, record) : record);
        if (kindFromTags(record.tags) !== null) {
          const priorStart = startRecords.get(identity);
          startRecords.set(identity, priorStart ? preferredRecord(priorStart, record) : record);
        }
      }
      for (const record of records.values()) {
        this.context.add(record.coordinate!, { layer, record });
        this.counters.contextRecordCount++;
      }
    }
    for (const record of startRecords.values()) {
      const feature = adaptiveStartFeatureFromRecord(record);
      if (!feature) continue;
      this.starts.add(feature.coordinate, feature);
      this.counters.startFeatureCount++;
    }
  }

  get stats(): AdaptiveStartFeatureIndexStats { return { ...this.counters }; }

  queryStarts(coordinate: Coordinate, radiusMeters: number): AdaptiveStartFeature[] {
    this.counters.startQueryCount++;
    return this.starts.query(coordinate, radiusMeters, this.counters)
      .sort((left, right) => textCompare(left.identity, right.identity));
  }

  /** Preserve every evidence layer used by the authoritative classifier, including elevation. */
  contextAt(coordinate: Coordinate, options: StartContextOptions = DEFAULT_START_CONTEXT_OPTIONS): FeatureIndex {
    this.counters.contextQueryCount++;
    const radius = Math.max(...Object.entries(options)
      .filter(([key]) => key !== 'minVerticalGainForBaseStartMeters').map(([, value]) => value));
    const result = emptyFeatureIndex();
    for (const item of this.context.query(coordinate, radius, this.counters)) result[item.layer].push(item.record);
    for (const layer of LAYERS) result[layer].sort((left, right) =>
      textCompare(`${left.objectType}:${osmId(left)}`, `${right.objectType}:${osmId(right)}`));
    return result;
  }
}
