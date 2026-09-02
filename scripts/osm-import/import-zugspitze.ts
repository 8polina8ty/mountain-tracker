import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Coordinate = [longitude: number, latitude: number];
type OsmTags = Record<string, string>;

interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: OsmTags;
}

interface OsmWay {
  type: "way";
  id: number;
  nodes?: number[];
  tags?: OsmTags;
}

interface OsmRelationMember {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
}

interface OsmRelation {
  type: "relation";
  id: number;
  members?: OsmRelationMember[];
  tags?: OsmTags;
}

type OsmElement = OsmNode | OsmWay | OsmRelation;

interface OverpassResponse {
  elements: OsmElement[];
}

interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

interface LineStringGeometry {
  type: "LineString";
  coordinates: Coordinate[];
}

interface MultiLineStringGeometry {
  type: "MultiLineString";
  coordinates: Coordinate[][];
}

type RouteGeometry = LineStringGeometry | MultiLineStringGeometry;

interface NormalizedRoute {
  source: "openstreetmap";
  sourceType: "relation";
  sourceId: string;
  sourceUrl: string;
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
  metadata: {
    route: string;
    from: string | null;
    to: string | null;
    roundtrip: string | null;
    osmcSymbol: string | null;
    memberWayCount: number;
    nestedRelationCount: number;
    tags: OsmTags;
  };
}

interface RejectedRoute {
  sourceId: string;
  name: string | null;
  reason: string;
}

interface NormalizedPeak {
  source: "openstreetmap";
  sourceType: "node";
  sourceId: string;
  sourceUrl: string;
  name: string | null;
  coordinates: Coordinate;
  elevationMeters: number | null;
  metadata: {
    tags: OsmTags;
  };
}

interface WayMember {
  wayId: number;
  role: string;
}

interface ExpandedMembers {
  wayMembers: WayMember[];
  nestedRelationIds: Set<number>;
  errors: string[];
}

interface ReconstructedRoute {
  route: NormalizedRoute;
  disconnected: boolean;
}

const ZUGSPITZE_BBOX: BoundingBox = {
  south: 47.395,
  west: 10.94,
  north: 47.45,
  east: 11.04,
};

const DEFAULT_OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
] as const;

const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";
const OSM_LICENSE = "Open Database License (ODbL) 1.0";
const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIRECTORY = resolve(SCRIPT_DIRECTORY, "../../data/osm");

function formatBoundingBox(boundingBox: BoundingBox): string {
  return [
    boundingBox.south,
    boundingBox.west,
    boundingBox.north,
    boundingBox.east,
  ].join(",");
}

function buildDiscoveryQuery(boundingBox: BoundingBox): string {
  const bbox = formatBoundingBox(boundingBox);

  return `[out:json][timeout:60];
(
  relation["type"="route"]["route"~"^(hiking|foot)$"](${bbox});
  node["natural"="peak"](${bbox});
);
out body qt;`;
}

function buildMemberQuery(relationIds: number[]): string {
  if (relationIds.length === 0) {
    return "[out:json];node(id:0);out body;";
  }

  const selectors = relationIds
    .map((relationId) => `  relation(${relationId});`)
    .join("\n");

  return `[out:json][timeout:120];
(
${selectors}
)->.routes;
(
  .routes;
  .routes >>;
);
out body qt;`;
}

function getOverpassEndpoints(): string[] {
  const configuredEndpoint = process.env.OVERPASS_API_URL?.trim();
  const endpoints = configuredEndpoint
    ? [configuredEndpoint, ...DEFAULT_OVERPASS_ENDPOINTS]
    : [...DEFAULT_OVERPASS_ENDPOINTS];

  return [...new Set(endpoints)];
}

function isOverpassResponse(value: unknown): value is OverpassResponse {
  if (!value || typeof value !== "object" || !("elements" in value)) {
    return false;
  }

  return Array.isArray((value as { elements: unknown }).elements);
}

async function requestOverpass(
  query: string,
  endpoints: string[],
): Promise<{ payload: OverpassResponse; endpoint: string }> {
  const failures: string[] = [];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "MountainTracker-OSMPrototype/1.0",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(150_000),
      });

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${responseText.slice(0, 240).replaceAll("\n", " ")}`,
        );
      }

      const parsed: unknown = JSON.parse(responseText);
      if (!isOverpassResponse(parsed)) {
        throw new Error("response did not contain an Overpass elements array");
      }

      return { payload: parsed, endpoint };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${endpoint}: ${message}`);
    }
  }

  throw new Error(`All Overpass endpoints failed:\n${failures.join("\n")}`);
}

function isRouteRelation(element: OsmElement): element is OsmRelation {
  return (
    element.type === "relation" &&
    element.tags?.type === "route" &&
    (element.tags.route === "hiking" || element.tags.route === "foot")
  );
}

function isPeakNode(element: OsmElement): element is OsmNode {
  return element.type === "node" && element.tags?.natural === "peak";
}

function expandRelationMembers(
  relationId: number,
  relations: Map<number, OsmRelation>,
  stack: Set<number> = new Set(),
): ExpandedMembers {
  const result: ExpandedMembers = {
    wayMembers: [],
    nestedRelationIds: new Set(),
    errors: [],
  };
  const relation = relations.get(relationId);

  if (!relation) {
    result.errors.push(`missing relation ${relationId}`);
    return result;
  }

  if (stack.has(relationId)) {
    result.errors.push(`cyclic relation membership at relation ${relationId}`);
    return result;
  }

  const nextStack = new Set(stack);
  nextStack.add(relationId);

  for (const member of relation.members ?? []) {
    if (member.type === "way") {
      result.wayMembers.push({ wayId: member.ref, role: member.role });
      continue;
    }

    if (member.type !== "relation") {
      continue;
    }

    result.nestedRelationIds.add(member.ref);
    const nested = expandRelationMembers(member.ref, relations, nextStack);
    result.wayMembers.push(...nested.wayMembers);
    nested.nestedRelationIds.forEach((id) => result.nestedRelationIds.add(id));
    result.errors.push(...nested.errors);
  }

  return result;
}

function getWayNodeIds(
  wayMember: WayMember,
  ways: Map<number, OsmWay>,
  nodes: Map<number, OsmNode>,
): { nodeIds: number[]; error: string | null } {
  const way = ways.get(wayMember.wayId);

  if (!way) {
    return { nodeIds: [], error: `missing way ${wayMember.wayId}` };
  }

  if (!way.nodes || way.nodes.length < 2) {
    return {
      nodeIds: [],
      error: `way ${wayMember.wayId} has fewer than two nodes`,
    };
  }

  const missingNodeId = way.nodes.find((nodeId) => !nodes.has(nodeId));
  if (missingNodeId !== undefined) {
    return {
      nodeIds: [],
      error: `way ${wayMember.wayId} is missing node ${missingNodeId}`,
    };
  }

  return { nodeIds: [...way.nodes], error: null };
}

function buildOrderedComponents(wayNodeIds: number[][]): number[][] {
  const components: number[][] = [];

  for (const originalNodeIds of wayNodeIds) {
    const nodeIds = [...originalNodeIds];
    const current = components.at(-1);

    if (!current) {
      components.push(nodeIds);
      continue;
    }

    const currentEnd = current.at(-1);
    const wayStart = nodeIds[0];
    const wayEnd = nodeIds.at(-1);

    if (currentEnd === wayStart) {
      current.push(...nodeIds.slice(1));
      continue;
    }

    if (currentEnd === wayEnd) {
      nodeIds.reverse();
      current.push(...nodeIds.slice(1));
      continue;
    }

    components.push(nodeIds);
  }

  return components;
}

function toCoordinates(
  components: number[][],
  nodes: Map<number, OsmNode>,
): Coordinate[][] {
  return components.map((component) =>
    component.map((nodeId) => {
      const node = nodes.get(nodeId);
      if (!node) {
        throw new Error(`node ${nodeId} disappeared during reconstruction`);
      }

      return [node.lon, node.lat];
    }),
  );
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function distanceBetween(start: Coordinate, end: Coordinate): number {
  const earthRadiusMeters = 6_371_008.8;
  const latitudeDelta = degreesToRadians(end[1] - start[1]);
  const longitudeDelta = degreesToRadians(end[0] - start[0]);
  const startLatitude = degreesToRadians(start[1]);
  const endLatitude = degreesToRadians(end[1]);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) *
      Math.cos(endLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    2 *
    earthRadiusMeters *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

function calculateDistance(components: Coordinate[][]): number {
  let distanceMeters = 0;

  for (const component of components) {
    for (let index = 1; index < component.length; index += 1) {
      distanceMeters += distanceBetween(component[index - 1], component[index]);
    }
  }

  return Math.round(distanceMeters);
}

function reconstructRoute(
  relation: OsmRelation,
  relations: Map<number, OsmRelation>,
  ways: Map<number, OsmWay>,
  nodes: Map<number, OsmNode>,
): { reconstructed: ReconstructedRoute | null; rejected: RejectedRoute | null } {
  const tags = relation.tags ?? {};
  const expanded = expandRelationMembers(relation.id, relations);
  const errors = [...expanded.errors];
  const wayNodeIds: number[][] = [];

  for (const wayMember of expanded.wayMembers) {
    const resolvedWay = getWayNodeIds(wayMember, ways, nodes);
    if (resolvedWay.error) {
      errors.push(resolvedWay.error);
    } else {
      wayNodeIds.push(resolvedWay.nodeIds);
    }
  }

  if (expanded.wayMembers.length === 0) {
    errors.push("relation has no way members");
  }

  if (errors.length > 0) {
    return {
      reconstructed: null,
      rejected: {
        sourceId: String(relation.id),
        name: tags.name ?? null,
        reason: [...new Set(errors)].join("; "),
      },
    };
  }

  const components = toCoordinates(buildOrderedComponents(wayNodeIds), nodes);
  const geometry: RouteGeometry =
    components.length === 1
      ? { type: "LineString", coordinates: components[0] }
      : { type: "MultiLineString", coordinates: components };
  const coordinatePoints = components.reduce(
    (total, component) => total + component.length,
    0,
  );

  return {
    reconstructed: {
      route: {
        source: "openstreetmap",
        sourceType: "relation",
        sourceId: String(relation.id),
        sourceUrl: `https://www.openstreetmap.org/relation/${relation.id}`,
        name: tags.name ?? null,
        ref: tags.ref ?? null,
        network: tags.network ?? null,
        operator: tags.operator ?? null,
        geometry,
        stats: {
          distanceMeters: calculateDistance(components),
          coordinatePoints,
          componentCount: components.length,
        },
        metadata: {
          route: tags.route ?? "hiking",
          from: tags.from ?? null,
          to: tags.to ?? null,
          roundtrip: tags.roundtrip ?? null,
          osmcSymbol: tags["osmc:symbol"] ?? null,
          memberWayCount: expanded.wayMembers.length,
          nestedRelationCount: expanded.nestedRelationIds.size,
          tags,
        },
      },
      disconnected: components.length > 1,
    },
    rejected: null,
  };
}

function parseElevation(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const elevation = Number.parseFloat(value);
  return Number.isFinite(elevation) ? elevation : null;
}

function normalizePeak(node: OsmNode): NormalizedPeak {
  const tags = node.tags ?? {};

  return {
    source: "openstreetmap",
    sourceType: "node",
    sourceId: String(node.id),
    sourceUrl: `https://www.openstreetmap.org/node/${node.id}`,
    name: tags.name ?? null,
    coordinates: [node.lon, node.lat],
    elevationMeters: parseElevation(tags.ele),
    metadata: { tags },
  };
}

function toGeoJsonFeature(route: NormalizedRoute) {
  return {
    type: "Feature" as const,
    id: `openstreetmap-relation-${route.sourceId}`,
    geometry: route.geometry,
    properties: {
      source: route.source,
      sourceType: route.sourceType,
      sourceId: route.sourceId,
      sourceUrl: route.sourceUrl,
      name: route.name,
      ref: route.ref,
      network: route.network,
      operator: route.operator,
      route: route.metadata.route,
      from: route.metadata.from,
      to: route.metadata.to,
      roundtrip: route.metadata.roundtrip,
      osmcSymbol: route.metadata.osmcSymbol,
      distanceMeters: route.stats.distanceMeters,
      coordinatePoints: route.stats.coordinatePoints,
      componentCount: route.stats.componentCount,
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const endpoints = getOverpassEndpoints();
  const discovery = await requestOverpass(
    buildDiscoveryQuery(ZUGSPITZE_BBOX),
    endpoints,
  );
  const discoveredRouteRelations = discovery.payload.elements
    .filter(isRouteRelation)
    .sort((left, right) => left.id - right.id);
  const discoveredPeaks = discovery.payload.elements
    .filter(isPeakNode)
    .sort((left, right) => left.id - right.id);
  const memberEndpoints = [
    discovery.endpoint,
    ...endpoints.filter((endpoint) => endpoint !== discovery.endpoint),
  ];
  const members = await requestOverpass(
    buildMemberQuery(discoveredRouteRelations.map((relation) => relation.id)),
    memberEndpoints,
  );

  const nodes = new Map<number, OsmNode>();
  const ways = new Map<number, OsmWay>();
  const relations = new Map<number, OsmRelation>();

  for (const element of members.payload.elements) {
    if (element.type === "node") {
      nodes.set(element.id, element);
    } else if (element.type === "way") {
      ways.set(element.id, element);
    } else {
      relations.set(element.id, element);
    }
  }

  const routes: NormalizedRoute[] = [];
  const rejectedRoutes: RejectedRoute[] = [];
  let disconnectedRouteCount = 0;

  for (const discoveredRelation of discoveredRouteRelations) {
    const relation = relations.get(discoveredRelation.id) ?? discoveredRelation;
    const result = reconstructRoute(relation, relations, ways, nodes);

    if (result.reconstructed) {
      routes.push(result.reconstructed.route);
      if (result.reconstructed.disconnected) {
        disconnectedRouteCount += 1;
      }
    } else if (result.rejected) {
      rejectedRoutes.push(result.rejected);
    }
  }

  const peaks = discoveredPeaks.map(normalizePeak);
  const generatedAt = new Date().toISOString();
  const hikingRelationCount = discoveredRouteRelations.filter(
    (relation) => relation.tags?.route === "hiking",
  ).length;
  const footRelationCount = discoveredRouteRelations.filter(
    (relation) => relation.tags?.route === "foot",
  ).length;
  const totalCoordinatePoints = routes.reduce(
    (total, route) => total + route.stats.coordinatePoints,
    0,
  );
  const routeNames = routes.map(
    (route) => route.name ?? route.ref ?? `OSM relation ${route.sourceId}`,
  );
  const disconnectedRoutes = routes
    .filter((route) => route.stats.componentCount > 1)
    .map((route) => ({
      sourceId: route.sourceId,
      name: route.name ?? route.ref ?? `OSM relation ${route.sourceId}`,
      componentCount: route.stats.componentCount,
    }));
  const provenance = {
    attribution: OSM_ATTRIBUTION,
    license: OSM_LICENSE,
    copyrightUrl: OSM_COPYRIGHT_URL,
    discoveryOverpassEndpoint: discovery.endpoint,
    memberOverpassEndpoint: members.endpoint,
    boundingBox: ZUGSPITZE_BBOX,
  };
  const report = {
    routeRelationsFound: discoveredRouteRelations.length,
    hikingRelationsFound: hikingRelationCount,
    footRelationsFound: footRelationCount,
    successfullyReconstructed: routes.length,
    disconnectedGeometry: disconnectedRouteCount,
    rejected: rejectedRoutes.length,
    peaksFound: peaks.length,
    totalCoordinatePoints,
    routeNames,
    disconnectedRoutes,
    rejectedRoutes,
  };

  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await Promise.all([
    writeJson(resolve(OUTPUT_DIRECTORY, "zugspitze-routes.json"), {
      generatedAt,
      source: "openstreetmap",
      provenance,
      report,
      routes,
    }),
    writeJson(resolve(OUTPUT_DIRECTORY, "zugspitze-peaks.json"), {
      generatedAt,
      source: "openstreetmap",
      provenance,
      count: peaks.length,
      peaks,
    }),
    writeJson(resolve(OUTPUT_DIRECTORY, "zugspitze-routes.geojson"), {
      type: "FeatureCollection",
      name: "Zugspitze OpenStreetMap hiking routes",
      generatedAt,
      attribution: OSM_ATTRIBUTION,
      license: OSM_LICENSE,
      copyrightUrl: OSM_COPYRIGHT_URL,
      boundingBox: ZUGSPITZE_BBOX,
      features: routes.map(toGeoJsonFeature),
    }),
  ]);

  console.log("Zugspitze OpenStreetMap importer report");
  console.log(`Hiking relations found: ${hikingRelationCount}`);
  console.log(`Foot relations found: ${footRelationCount}`);
  console.log(`Successfully reconstructed: ${routes.length}`);
  console.log(`Disconnected geometry: ${disconnectedRouteCount}`);
  console.log(`Rejected: ${rejectedRoutes.length}`);
  console.log(`Peaks found: ${peaks.length}`);
  console.log(`Total coordinate points: ${totalCoordinatePoints}`);
  console.log("Route names:");
  routeNames.forEach((name) => console.log(`- ${name}`));

  if (rejectedRoutes.length > 0) {
    console.log("Rejected routes:");
    rejectedRoutes.forEach((route) =>
      console.log(`- ${route.sourceId} (${route.name ?? "unnamed"}): ${route.reason}`),
    );
  }

  if (disconnectedRoutes.length > 0) {
    console.log("Disconnected routes:");
    disconnectedRoutes.forEach((route) =>
      console.log(
        `- ${route.sourceId} (${route.name}): ${route.componentCount} components`,
      ),
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
