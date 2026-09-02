import {
  calculateCoordinateDistanceMeters,
  type Coordinate,
  type RouteGeometry,
} from "./peak-matcher.ts";
import type {
  OplRelation,
  OplWay,
  OsmTags,
} from "./opl-parser.ts";

export const OSM_ATTRIBUTION = "\u00a9 OpenStreetMap contributors";
export const OSM_LICENSE = "ODbL-1.0";
export const OSM_PROVENANCE_ID = "openstreetmap-odbl-geofabrik-alps";

export interface BulkObjectStore {
  getWay(id: number): OplWay | null;
  getRelation(id: number): OplRelation | null;
}

export interface BulkRouteRecord {
  source: "openstreetmap";
  sourceType: "relation";
  sourceId: string;
  sourceUrl: string;
  provenanceId: string;
  license: "ODbL-1.0";
  attribution: string;
  name: string | null;
  ref: string | null;
  network: string | null;
  operator: string | null;
  geometry: RouteGeometry;
  stats: {
    distanceMeters: number;
    coordinatePoints: number;
    componentCount: number;
  };
  flags: {
    disconnected: boolean;
    heavilyFragmented: boolean;
  };
  metadata: {
    route: string;
    from: string | null;
    to: string | null;
    roundtrip: string | null;
    osmcSymbol: string | null;
    website: string | null;
    description: string | null;
    memberWayCount: number;
    nestedRelationCount: number;
    tags: OsmTags;
  };
}

export interface RejectedBulkRoute {
  sourceId: string;
  name: string | null;
  reasons: string[];
}

interface ExpandedWay {
  way: OplWay;
  role: string;
}

function expandRelation(
  relationId: number,
  store: BulkObjectStore,
  stack: Set<number> = new Set(),
): { ways: ExpandedWay[]; nestedIds: Set<number>; errors: string[] } {
  const relation = store.getRelation(relationId);
  const ways: ExpandedWay[] = [];
  const nestedIds = new Set<number>();
  const errors: string[] = [];

  if (!relation) {
    return { ways, nestedIds, errors: [`missing relation ${relationId}`] };
  }
  if (stack.has(relationId)) {
    return {
      ways,
      nestedIds,
      errors: [`cyclic relation membership at ${relationId}`],
    };
  }

  const nextStack = new Set(stack);
  nextStack.add(relationId);
  for (const member of relation.members) {
    if (member.type === "way") {
      const way = store.getWay(member.ref);
      if (!way) {
        errors.push(`missing way ${member.ref}`);
      } else {
        ways.push({ way, role: member.role });
      }
    } else if (member.type === "relation") {
      nestedIds.add(member.ref);
      const nested = expandRelation(member.ref, store, nextStack);
      ways.push(...nested.ways);
      nested.nestedIds.forEach((id) => nestedIds.add(id));
      errors.push(...nested.errors);
    }
  }

  return { ways, nestedIds, errors };
}

function buildComponents(ways: ExpandedWay[]): Coordinate[][] {
  const components: Array<{ nodeIds: number[]; coordinates: Coordinate[] }> = [];

  for (const { way } of ways) {
    if (way.nodes.length < 2) {
      throw new Error(`way ${way.id} has fewer than two nodes`);
    }
    const missingLocation = way.nodes.find((node) => !node.coordinate);
    if (missingLocation) {
      throw new Error(
        `way ${way.id} node ${missingLocation.nodeId} has no embedded location`,
      );
    }

    const nodeIds = way.nodes.map((node) => node.nodeId);
    const coordinates = way.nodes.map((node) => node.coordinate as Coordinate);
    const current = components.at(-1);
    if (!current) {
      components.push({ nodeIds, coordinates });
      continue;
    }

    const currentEnd = current.nodeIds.at(-1);
    if (currentEnd === nodeIds[0]) {
      current.nodeIds.push(...nodeIds.slice(1));
      current.coordinates.push(...coordinates.slice(1));
    } else if (currentEnd === nodeIds.at(-1)) {
      nodeIds.reverse();
      coordinates.reverse();
      current.nodeIds.push(...nodeIds.slice(1));
      current.coordinates.push(...coordinates.slice(1));
    } else {
      components.push({ nodeIds, coordinates });
    }
  }

  return components.map((component) => component.coordinates);
}

function routeDistance(components: Coordinate[][]): number {
  let distanceMeters = 0;
  for (const component of components) {
    for (let index = 1; index < component.length; index += 1) {
      distanceMeters += calculateCoordinateDistanceMeters(
        component[index - 1],
        component[index],
      );
    }
  }
  return Math.round(distanceMeters);
}

export function reconstructBulkRoute(
  relationId: number,
  store: BulkObjectStore,
): { route: BulkRouteRecord | null; rejected: RejectedBulkRoute | null } {
  const relation = store.getRelation(relationId);
  if (!relation) {
    return {
      route: null,
      rejected: {
        sourceId: String(relationId),
        name: null,
        reasons: [`missing relation ${relationId}`],
      },
    };
  }

  const expanded = expandRelation(relationId, store);
  const errors = [...expanded.errors];
  if (expanded.ways.length === 0) {
    errors.push("relation has no way members");
  }

  let components: Coordinate[][] = [];
  if (errors.length === 0) {
    try {
      components = buildComponents(expanded.ways);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length > 0) {
    return {
      route: null,
      rejected: {
        sourceId: String(relationId),
        name: relation.tags.name ?? null,
        reasons: [...new Set(errors)],
      },
    };
  }

  const geometry: RouteGeometry =
    components.length === 1
      ? { type: "LineString", coordinates: components[0] }
      : { type: "MultiLineString", coordinates: components };
  const coordinatePoints = components.reduce(
    (total, component) => total + component.length,
    0,
  );
  const tags = relation.tags;

  return {
    route: {
      source: "openstreetmap",
      sourceType: "relation",
      sourceId: String(relation.id),
      sourceUrl: `https://www.openstreetmap.org/relation/${relation.id}`,
      provenanceId: OSM_PROVENANCE_ID,
      license: OSM_LICENSE,
      attribution: OSM_ATTRIBUTION,
      name: tags.name ?? null,
      ref: tags.ref ?? null,
      network: tags.network ?? null,
      operator: tags.operator ?? null,
      geometry,
      stats: {
        distanceMeters: routeDistance(components),
        coordinatePoints,
        componentCount: components.length,
      },
      flags: {
        disconnected: components.length > 1,
        heavilyFragmented: components.length >= 10,
      },
      metadata: {
        route: tags.route ?? "hiking",
        from: tags.from ?? null,
        to: tags.to ?? null,
        roundtrip: tags.roundtrip ?? null,
        osmcSymbol: tags["osmc:symbol"] ?? null,
        website: tags.website ?? null,
        description: tags.description ?? null,
        memberWayCount: expanded.ways.length,
        nestedRelationCount: expanded.nestedIds.size,
        tags,
      },
    },
    rejected: null,
  };
}
