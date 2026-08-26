export type TopologyCoordinate = [longitude: number, latitude: number];

export type TopologyRouteGeometry =
  | { type: "LineString"; coordinates: TopologyCoordinate[] }
  | { type: "MultiLineString"; coordinates: TopologyCoordinate[][] };

/** Maximum geographic separation at which component coordinates represent one node. */
export const ROUTE_TOPOLOGY_TOLERANCE_METERS = 1;

/** Existing Phase 3 endpoint convention used only to orient preview markers. */
export const SUMMIT_ENDPOINT_ORIENTATION_TOLERANCE_METERS = 10;

export type RouteTopologyClassification =
  | "SIMPLE"
  | "CONNECTED_TWO_ENDPOINTS"
  | "BRANCHING"
  | "DISCONNECTED"
  | "AMBIGUOUS";

export type EndpointOrientationReason =
  | "CONFIRMED_SUMMIT_ENDPOINT"
  | "DETERMINISTIC_COMPONENT_ENDPOINT_ORDER"
  | "INFERRED_BRANCHING_PHYSICAL_ENDPOINTS"
  | "TOPOLOGY_AMBIGUOUS";

export type EndpointSelectionWarning =
  | "BRANCHING_ENDPOINT_SELECTION_AMBIGUOUS"
  | "DISCONNECTED_GLOBAL_ENDPOINTS_UNAVAILABLE"
  | "AMBIGUOUS_GLOBAL_ENDPOINTS_UNAVAILABLE";

export interface RouteComponentTopology {
  componentIndex: number;
  pointCount: number;
  lengthMeters: number;
  startCoordinate: TopologyCoordinate;
  endCoordinate: TopologyCoordinate;
}

export interface RouteEndpointNode {
  coordinate: TopologyCoordinate;
  degree: number;
  componentEndpoints: Array<{
    componentIndex: number;
    position: "start" | "end";
  }>;
  interiorComponentIndexes: number[];
}

export interface RouteEndpointSelection {
  available: boolean;
  startCoordinate: TopologyCoordinate | null;
  endCoordinate: TopologyCoordinate | null;
  orientationReason: EndpointOrientationReason;
  ambiguous: boolean;
  warning: EndpointSelectionWarning | null;
  summitEndpointDistanceMeters: number | null;
  straightLineDistanceMeters: number | null;
}

export interface RouteTopologyAnalysis {
  classification: RouteTopologyClassification;
  geometryType: TopologyRouteGeometry["type"];
  componentCount: number;
  pointCount: number;
  components: RouteComponentTopology[];
  endpointNodes: RouteEndpointNode[];
  physicalEndpoints: RouteEndpointNode[];
  physicalEndpointCount: number;
  connectedGroups: number[][];
  connectedGroupCount: number;
  genuinelyDisconnected: boolean;
  ambiguousStartEnd: boolean;
  toleranceMeters: number;
}

interface EndpointOccurrence {
  componentIndex: number;
  position: "start" | "end";
  coordinate: TopologyCoordinate;
}

class DisjointSet {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  find(value: number): number {
    const parent = this.parents[value];
    if (parent !== value) this.parents[value] = this.find(parent);
    return this.parents[value];
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parents[rightRoot] = leftRoot;
  }
}

function round(value: number, digits = 1): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

export function topologyCoordinateDistanceMeters(
  left: TopologyCoordinate,
  right: TopologyCoordinate,
): number {
  const earthRadiusMeters = 6_371_008.8;
  const radians = Math.PI / 180;
  const latitudeDelta = (right[1] - left[1]) * radians;
  const longitudeDelta = (right[0] - left[0]) * radians;
  const leftLatitude = left[1] * radians;
  const rightLatitude = right[1] * radians;
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(a)));
}

function componentsOf(geometry: TopologyRouteGeometry): TopologyCoordinate[][] {
  return geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
}

function componentLength(component: TopologyCoordinate[]): number {
  let distanceMeters = 0;
  for (let index = 1; index < component.length; index += 1) {
    distanceMeters += topologyCoordinateDistanceMeters(
      component[index - 1],
      component[index],
    );
  }
  return distanceMeters;
}

function sameNode(
  left: TopologyCoordinate,
  right: TopologyCoordinate,
  toleranceMeters: number,
): boolean {
  return topologyCoordinateDistanceMeters(left, right) <= toleranceMeters;
}

export function analyzeRouteTopology(
  geometry: TopologyRouteGeometry,
  toleranceMeters = ROUTE_TOPOLOGY_TOLERANCE_METERS,
): RouteTopologyAnalysis {
  if (!Number.isFinite(toleranceMeters) || toleranceMeters < 0) {
    throw new Error("Route topology tolerance must be a finite non-negative number.");
  }
  const components = componentsOf(geometry);
  if (components.length === 0 || components.some((component) => component.length < 2)) {
    throw new Error("Route geometry must contain at least two coordinates per component.");
  }

  const componentDiagnostics = components.map((component, componentIndex) => ({
    componentIndex,
    pointCount: component.length,
    lengthMeters: round(componentLength(component)),
    startCoordinate: component[0],
    endCoordinate: component.at(-1) as TopologyCoordinate,
  }));
  const occurrences: EndpointOccurrence[] = componentDiagnostics.flatMap((component) => [
    {
      componentIndex: component.componentIndex,
      position: "start" as const,
      coordinate: component.startCoordinate,
    },
    {
      componentIndex: component.componentIndex,
      position: "end" as const,
      coordinate: component.endCoordinate,
    },
  ]);
  const endpointSets = new DisjointSet(occurrences.length);
  const componentSets = new DisjointSet(components.length);

  for (let left = 0; left < occurrences.length; left += 1) {
    for (let right = left + 1; right < occurrences.length; right += 1) {
      if (!sameNode(occurrences[left].coordinate, occurrences[right].coordinate, toleranceMeters)) {
        continue;
      }
      endpointSets.union(left, right);
      if (occurrences[left].componentIndex !== occurrences[right].componentIndex) {
        componentSets.union(
          occurrences[left].componentIndex,
          occurrences[right].componentIndex,
        );
      }
    }
  }

  const endpointClusters = new Map<number, EndpointOccurrence[]>();
  occurrences.forEach((occurrence, index) => {
    const root = endpointSets.find(index);
    const cluster = endpointClusters.get(root) ?? [];
    cluster.push(occurrence);
    endpointClusters.set(root, cluster);
  });

  const endpointNodes = [...endpointClusters.values()].map((cluster) => {
    const representative = cluster[0].coordinate;
    const interiorComponentIndexes: number[] = [];
    components.forEach((component, componentIndex) => {
      const touchesInterior = component
        .slice(1, -1)
        .some((coordinate) => sameNode(representative, coordinate, toleranceMeters));
      if (!touchesInterior) return;
      interiorComponentIndexes.push(componentIndex);
      for (const occurrence of cluster) {
        if (occurrence.componentIndex !== componentIndex) {
          componentSets.union(occurrence.componentIndex, componentIndex);
        }
      }
    });
    return {
      coordinate: representative,
      degree: cluster.length + interiorComponentIndexes.length * 2,
      componentEndpoints: cluster.map(({ componentIndex, position }) => ({
        componentIndex,
        position,
      })),
      interiorComponentIndexes,
    };
  });
  const physicalEndpoints = endpointNodes.filter((endpoint) => endpoint.degree === 1);
  const groupsByRoot = new Map<number, number[]>();
  components.forEach((_, componentIndex) => {
    const root = componentSets.find(componentIndex);
    const group = groupsByRoot.get(root) ?? [];
    group.push(componentIndex);
    groupsByRoot.set(root, group);
  });
  const connectedGroups = [...groupsByRoot.values()].sort(
    (left, right) => left[0] - right[0],
  );
  const genuinelyDisconnected = connectedGroups.length > 1;
  const hasBranchNode = endpointNodes.some((endpoint) => endpoint.degree > 2);
  let classification: RouteTopologyClassification;
  if (genuinelyDisconnected) classification = "DISCONNECTED";
  else if (physicalEndpoints.length > 2 || hasBranchNode) classification = "BRANCHING";
  else if (physicalEndpoints.length !== 2) classification = "AMBIGUOUS";
  else if (components.length === 1) classification = "SIMPLE";
  else classification = "CONNECTED_TWO_ENDPOINTS";

  return {
    classification,
    geometryType: geometry.type,
    componentCount: components.length,
    pointCount: components.reduce((sum, component) => sum + component.length, 0),
    components: componentDiagnostics,
    endpointNodes,
    physicalEndpoints,
    physicalEndpointCount: physicalEndpoints.length,
    connectedGroups,
    connectedGroupCount: connectedGroups.length,
    genuinelyDisconnected,
    ambiguousStartEnd:
      classification === "BRANCHING" ||
      classification === "DISCONNECTED" ||
      classification === "AMBIGUOUS",
    toleranceMeters,
  };
}

export function selectRouteEndpoints(
  topology: RouteTopologyAnalysis,
  confirmedSummitCoordinates: TopologyCoordinate[] = [],
  summitToleranceMeters = SUMMIT_ENDPOINT_ORIENTATION_TOLERANCE_METERS,
): RouteEndpointSelection {
  if (topology.classification === "DISCONNECTED") {
    return {
      available: false,
      startCoordinate: null,
      endCoordinate: null,
      orientationReason: "TOPOLOGY_AMBIGUOUS",
      ambiguous: true,
      warning: "DISCONNECTED_GLOBAL_ENDPOINTS_UNAVAILABLE",
      summitEndpointDistanceMeters: null,
      straightLineDistanceMeters: null,
    };
  }
  const endpointDistances = topology.physicalEndpoints.map((endpoint) =>
    confirmedSummitCoordinates.length === 0
      ? Number.POSITIVE_INFINITY
      : Math.min(
          ...confirmedSummitCoordinates.map((summit) =>
            topologyCoordinateDistanceMeters(endpoint.coordinate, summit),
          ),
        ),
  );
  const summitEndpointIndexes = endpointDistances
    .map((distance, index) => ({ distance, index }))
    .filter(({ distance }) => distance <= summitToleranceMeters);

  if (topology.classification === "BRANCHING") {
    if (topology.physicalEndpoints.length < 2) {
      return {
        available: false,
        startCoordinate: null,
        endCoordinate: null,
        orientationReason: "TOPOLOGY_AMBIGUOUS",
        ambiguous: true,
        warning: "AMBIGUOUS_GLOBAL_ENDPOINTS_UNAVAILABLE",
        summitEndpointDistanceMeters: null,
        straightLineDistanceMeters: null,
      };
    }
    let startIndex = 0;
    let endIndex = 1;
    let summitEndpointDistanceMeters: number | null = null;
    if (summitEndpointIndexes.length === 1) {
      endIndex = summitEndpointIndexes[0].index;
      summitEndpointDistanceMeters = round(summitEndpointIndexes[0].distance);
      const otherIndexes = topology.physicalEndpoints
        .map((_, index) => index)
        .filter((index) => index !== endIndex);
      startIndex = otherIndexes.reduce((farthestIndex, index) => {
        const farthestDistance = topologyCoordinateDistanceMeters(
          topology.physicalEndpoints[farthestIndex].coordinate,
          topology.physicalEndpoints[endIndex].coordinate,
        );
        const distance = topologyCoordinateDistanceMeters(
          topology.physicalEndpoints[index].coordinate,
          topology.physicalEndpoints[endIndex].coordinate,
        );
        return distance > farthestDistance ? index : farthestIndex;
      });
    } else {
      let farthestDistance = Number.NEGATIVE_INFINITY;
      for (let left = 0; left < topology.physicalEndpoints.length; left += 1) {
        for (let right = left + 1; right < topology.physicalEndpoints.length; right += 1) {
          const distance = topologyCoordinateDistanceMeters(
            topology.physicalEndpoints[left].coordinate,
            topology.physicalEndpoints[right].coordinate,
          );
          if (distance > farthestDistance) {
            farthestDistance = distance;
            startIndex = left;
            endIndex = right;
          }
        }
      }
    }
    // Select only existing degree-one nodes. Straight-line comparison never alters or
    // bridges the stored component geometry.
    const startCoordinate = topology.physicalEndpoints[startIndex].coordinate;
    const endCoordinate = topology.physicalEndpoints[endIndex].coordinate;
    return {
      available: true,
      startCoordinate,
      endCoordinate,
      orientationReason: "INFERRED_BRANCHING_PHYSICAL_ENDPOINTS",
      ambiguous: true,
      warning: "BRANCHING_ENDPOINT_SELECTION_AMBIGUOUS",
      summitEndpointDistanceMeters,
      straightLineDistanceMeters: round(
        topologyCoordinateDistanceMeters(startCoordinate, endCoordinate),
      ),
    };
  }

  if (topology.ambiguousStartEnd || topology.physicalEndpoints.length !== 2) {
    return {
      available: false,
      startCoordinate: null,
      endCoordinate: null,
      orientationReason: "TOPOLOGY_AMBIGUOUS",
      ambiguous: true,
      warning: "AMBIGUOUS_GLOBAL_ENDPOINTS_UNAVAILABLE",
      summitEndpointDistanceMeters: null,
      straightLineDistanceMeters: null,
    };
  }
  let startIndex = 0;
  let endIndex = 1;
  let orientationReason: EndpointOrientationReason =
    "DETERMINISTIC_COMPONENT_ENDPOINT_ORDER";
  let summitEndpointDistanceMeters: number | null = null;
  if (summitEndpointIndexes.length === 1) {
    endIndex = summitEndpointIndexes[0].index;
    startIndex = endIndex === 0 ? 1 : 0;
    orientationReason = "CONFIRMED_SUMMIT_ENDPOINT";
    summitEndpointDistanceMeters = round(summitEndpointIndexes[0].distance);
  }
  const startCoordinate = topology.physicalEndpoints[startIndex].coordinate;
  const endCoordinate = topology.physicalEndpoints[endIndex].coordinate;
  return {
    available: true,
    startCoordinate,
    endCoordinate,
    orientationReason,
    ambiguous: false,
    warning: null,
    summitEndpointDistanceMeters,
    straightLineDistanceMeters: round(
      topologyCoordinateDistanceMeters(startCoordinate, endCoordinate),
    ),
  };
}
