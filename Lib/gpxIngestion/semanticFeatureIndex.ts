// Phase 12E offline multilingual semantic feature index over the frozen
// open-data OSM feature catalog. Deterministic and content-hashed; entries
// carry every `name*` variant plus feature-type and coordinate provenance.

import type { Coordinate } from "./types.ts";
import { featureNameVariants, normalizeSemanticName } from "./nameNormalization.ts";
import { sha256Stable } from "./hashing.ts";
import type { SemanticAnchorType } from "./routeDiscovery.ts";

export const SEMANTIC_FEATURE_INDEX_VERSION =
  "mountain-tracker/semantic-feature-index/v3" as const;

export type SemanticFeatureLayer =
  | "alpine-huts"
  | "wilderness-huts"
  | "parking"
  | "stations"
  | "halts"
  | "bus-stops"
  | "trailheads"
  | "villages"
  | "hamlets"
  | "isolated-dwellings"
  | "farms"
  | "saddles"
  | "mountain-passes"
  | "ridges"
  | "peaks"
  | "trailhead-info"
  | "historic-status";

export interface SemanticFeatureRecordSource {
  layer: SemanticFeatureLayer;
  objectType: "node" | "way" | "relation";
  osmid: string;
  coordinate: Coordinate | null;
  tags: Readonly<Record<string, string>>;
}

export interface SemanticFeatureIndexEntry {
  sourceKey: "openstreetmap";
  layer: SemanticFeatureLayer;
  objectType: "node" | "way" | "relation";
  osmId: number;
  coordinate: Coordinate;
  primaryName: string | null;
  nameVariants: string[];
  expectedTypes: SemanticAnchorType[];
  tags: Readonly<Record<string, string>>;
}

export interface SemanticFeatureIndex {
  schemaVersion: typeof SEMANTIC_FEATURE_INDEX_VERSION;
  entries: SemanticFeatureIndexEntry[];
  indexHash: string;
  wantedNameCount: number;
  sourceHashes: Record<string, string>;
  byName?: ReadonlyMap<string, readonly SemanticFeatureIndexEntry[]>;
}

const LAYER_EXPECTED_TYPES: Readonly<Record<SemanticFeatureLayer, SemanticAnchorType[]>> = {
  "alpine-huts": ["HUT"],
  "wilderness-huts": ["HUT"],
  parking: ["PARKING"],
  stations: ["PARKING", "OTHER_NAMED_FEATURE"],
  halts: ["PARKING", "OTHER_NAMED_FEATURE"],
  "bus-stops": ["PARKING", "OTHER_NAMED_FEATURE"],
  trailheads: ["TRAILHEAD"],
  villages: ["SETTLEMENT"],
  hamlets: ["SETTLEMENT"],
  "isolated-dwellings": ["SETTLEMENT"],
  farms: ["SETTLEMENT"],
  saddles: ["SADDLE"],
  "mountain-passes": ["PASS", "SADDLE"],
  ridges: ["OTHER_NAMED_FEATURE"],
  peaks: ["SUMMIT"],
  "trailhead-info": ["TRAILHEAD", "JUNCTION"],
  "historic-status": ["OTHER_NAMED_FEATURE"],
};

export function semanticFeatureIndexLayer(): SemanticFeatureLayer[] {
  // Historical waypoints are a separately fingerprinted supplemental catalog.
  return Object.keys(LAYER_EXPECTED_TYPES).filter(layer => layer !== 'historic-status') as SemanticFeatureLayer[];
}

export function hasHistoricStatusEvidence(tags: Readonly<Record<string, string>>): boolean {
  return tags.historic === 'ruins' || tags.ruins === 'yes' || tags.building === 'ruins' ||
    tags.archaeological_site === 'ruins' || tags['building:condition'] === 'recognizable_remains' ||
    tags.abandoned === 'yes' || tags['abandoned:building'] === 'yes';
}

export function semanticFeatureIndexEntry(entry: {
  layer: SemanticFeatureLayer;
  source: SemanticFeatureRecordSource;
}): SemanticFeatureIndexEntry | null {
  const source = entry.source;
  if (entry.layer === 'historic-status' && !hasHistoricStatusEvidence(source.tags)) return null;
  if (!source.coordinate || source.coordinate.length < 2 || !Number.isFinite(source.coordinate[0]) || !Number.isFinite(source.coordinate[1])) return null;
  if (source.objectType !== "node" && source.objectType !== "way" && source.objectType !== "relation") {
    return null;
  }
  const osmId = Number(source.osmid.replace(/^[nwr]/, ""));
  if (!Number.isSafeInteger(osmId) || osmId <= 0) return null;
  const variants = featureNameVariants(source.tags);
  const primaryName = source.tags.name?.normalize("NFKC").trim() ?? null;
  if (!primaryName && variants.length === 0) return null;
  return {
    sourceKey: "openstreetmap",
    layer: entry.layer,
    objectType: source.objectType,
    osmId,
    coordinate: [...source.coordinate] as Coordinate,
    primaryName,
    nameVariants: variants,
    expectedTypes: LAYER_EXPECTED_TYPES[entry.layer],
    tags: source.tags,
  };
}

export interface SemanticFeatureIndexInput {
  sourceHashes: Record<string, string>;
  wantedNames: ReadonlySet<string>;
  collect: Array<{ layer: SemanticFeatureLayer; records: SemanticFeatureRecordSource[] }>;
}

export function buildSemanticFeatureIndex(input: SemanticFeatureIndexInput): SemanticFeatureIndex {
  const wanted = new Set([...input.wantedNames].map(normalizeSemanticName));
  const entries: SemanticFeatureIndexEntry[] = [];
  const seen = new Set<string>();
  for (const block of input.collect) {
    for (const source of block.records) {
      const entry = semanticFeatureIndexEntry({ layer: block.layer, source });
      if (!entry) continue;
      const normalizedVariants = new Set([...(entry.nameVariants ?? [])].map(normalizeSemanticName));
      const primary = entry.primaryName ? normalizeSemanticName(entry.primaryName) : null;
      const namePool = [...normalizedVariants, ...(primary ? [primary] : [])];
      if (!namePool.some((name) => wanted.has(name))) continue;
      const key = `${entry.objectType}:${entry.osmId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  entries.sort((left, right) => left.osmId - right.osmId || left.objectType.localeCompare(right.objectType));
  const content = {
    schemaVersion: SEMANTIC_FEATURE_INDEX_VERSION,
    entries,
    wantedNameCount: input.wantedNames.size,
    sourceHashes: input.sourceHashes,
  };
  return attachSemanticNameLookup({ ...content, indexHash: sha256Stable(content) });
}

export function attachSemanticNameLookup(index: SemanticFeatureIndex): SemanticFeatureIndex {
  const byName = new Map<string, SemanticFeatureIndexEntry[]>();
  for (const entry of index.entries) for (const name of entry.nameVariants) {
    const list = byName.get(name) ?? []; list.push(entry); byName.set(name, list);
  }
  // Runtime-only lookup: excluded from persisted content and hashes.
  Object.defineProperty(index, 'byName', { value: byName, enumerable: false });
  return index;
}
