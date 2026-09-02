import {
  calculateCoordinateDistanceMeters,
  type Coordinate,
  type RouteGeometry,
} from "./peak-matcher.ts";
import {
  analyzeRouteTopology,
  selectRouteEndpoints,
  type RouteEndpointSelection,
  type RouteTopologyClassification,
} from "../../Lib/osmStagingPreview/topology.ts";

export const ENDPOINT_TOLERANCE_METERS = 1;

export interface ComponentDiagnostic {
  componentIndex: number;
  pointCount: number;
  lengthMeters: number;
  startCoordinate: Coordinate;
  endCoordinate: Coordinate;
}

export interface EndpointDistanceDiagnostic {
  leftComponentIndex: number;
  rightComponentIndex: number;
  startToStartMeters: number;
  startToEndMeters: number;
  endToStartMeters: number;
  endToEndMeters: number;
}

export interface PhysicalEndpointDiagnostic {
  coordinate: Coordinate;
  degree: number;
  componentEndpoints: Array<{
    componentIndex: number;
    position: "start" | "end";
  }>;
}

export type ComponentOrderingClassification =
  | "SINGLE_LINESTRING"
  | "ORDERED"
  | "REVERSED_COMPONENT"
  | "REORDERED_COMPONENTS"
  | "REORDERED_AND_REVERSED_COMPONENTS"
  | "DISCONNECTED"
  | "AMBIGUOUS_TOPOLOGY";

export interface StartEndTopologyDiagnostic {
  geometryType: RouteGeometry["type"];
  componentCount: number;
  pointCount: number;
  components: ComponentDiagnostic[];
  pairwiseEndpointDistances: EndpointDistanceDiagnostic[];
  displayedStartCoordinate: Coordinate;
  displayedEndCoordinate: Coordinate;
  displayedStartIsPhysicalEndpoint: boolean;
  displayedEndIsPhysicalEndpoint: boolean;
  physicalEndpoints: PhysicalEndpointDiagnostic[];
  physicalEndpointCount: number;
  topologyClassification: RouteTopologyClassification;
  connectedGroups: number[][];
  componentGroupCount: number;
  genuinelyDisconnected: boolean;
  ambiguousStartEnd: boolean;
  orderedComponentIndexes: number[] | null;
  reversedComponentIndexes: number[];
  componentsReordered: boolean;
  orderingClassification: ComponentOrderingClassification;
  sharedCoordinateCount: number;
  overlappingSegmentCount: number;
  overlappingComponents: boolean;
  nearlyConnectedEndpointPairs: number;
  topologyEndpointDistanceMeters: number | null;
}

interface EndpointOccurrence {
  componentIndex: number;
  position: "start" | "end";
  coordinate: Coordinate;
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

function componentsOf(geometry: RouteGeometry): Coordinate[][] {
  return geometry.type === "LineString"
    ? [geometry.coordinates]
    : geometry.coordinates;
}

function componentLength(component: Coordinate[]): number {
  let distance = 0;
  for (let index = 1; index < component.length; index += 1) {
    distance += calculateCoordinateDistanceMeters(
      component[index - 1],
      component[index],
    );
  }
  return distance;
}

function samePoint(
  left: Coordinate,
  right: Coordinate,
  toleranceMeters: number,
): boolean {
  return calculateCoordinateDistanceMeters(left, right) <= toleranceMeters;
}

function findComponentChain(
  components: Coordinate[][],
  toleranceMeters: number,
): Array<{ componentIndex: number; reversed: boolean }> | null {
  if (components.length === 0 || components.length > 8) return null;

  const solutions: Array<Array<{ componentIndex: number; reversed: boolean }>> = [];

  const visit = (
    path: Array<{ componentIndex: number; reversed: boolean }>,
    used: Set<number>,
  ): void => {
    if (path.length === components.length) {
      solutions.push(path);
      return;
    }
    const previous = path.at(-1);
    const previousEnd = previous
      ? components[previous.componentIndex][
          previous.reversed ? 0 : components[previous.componentIndex].length - 1
        ]
      : null;

    for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
      if (used.has(componentIndex)) continue;
      for (const reversed of [false, true]) {
        const component = components[componentIndex];
        const start = component[reversed ? component.length - 1 : 0];
        if (previousEnd && !samePoint(previousEnd, start, toleranceMeters)) continue;
        const nextUsed = new Set(used);
        nextUsed.add(componentIndex);
        visit([...path, { componentIndex, reversed }], nextUsed);
      }
    }
  };

  visit([], new Set());
  solutions.sort((left, right) => {
    const reversalDifference =
      left.filter((value) => value.reversed).length -
      right.filter((value) => value.reversed).length;
    if (reversalDifference !== 0) return reversalDifference;
    const leftReorders = left.filter((value, index) => value.componentIndex !== index).length;
    const rightReorders = right.filter((value, index) => value.componentIndex !== index).length;
    if (leftReorders !== rightReorders) return leftReorders - rightReorders;
    return JSON.stringify(left).localeCompare(JSON.stringify(right));
  });
  return solutions[0] ?? null;
}

function coordinateKey(coordinate: Coordinate): string {
  return `${coordinate[0]},${coordinate[1]}`;
}

export function analyzeStartEndTopology(
  geometry: RouteGeometry,
  toleranceMeters = ENDPOINT_TOLERANCE_METERS,
): StartEndTopologyDiagnostic {
  const sharedTopology = analyzeRouteTopology(geometry, toleranceMeters);
  const components = componentsOf(geometry);
  if (
    components.length === 0 ||
    components.some((component) => component.length < 2)
  ) {
    throw new Error("Route geometry must contain at least two coordinates per component.");
  }

  const componentDiagnostics = components.map((component, componentIndex) => ({
    componentIndex,
    pointCount: component.length,
    lengthMeters: round(componentLength(component)),
    startCoordinate: component[0],
    endCoordinate: component.at(-1) as Coordinate,
  }));
  const endpointOccurrences = componentDiagnostics.flatMap((component) => [
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
  const endpointSets = new DisjointSet(endpointOccurrences.length);
  const componentSets = new DisjointSet(components.length);
  let nearlyConnectedEndpointPairs = 0;

  for (let left = 0; left < endpointOccurrences.length; left += 1) {
    for (let right = left + 1; right < endpointOccurrences.length; right += 1) {
      const leftEndpoint = endpointOccurrences[left];
      const rightEndpoint = endpointOccurrences[right];
      const distance = calculateCoordinateDistanceMeters(
        leftEndpoint.coordinate,
        rightEndpoint.coordinate,
      );
      if (distance <= toleranceMeters) {
        endpointSets.union(left, right);
        if (leftEndpoint.componentIndex !== rightEndpoint.componentIndex) {
          componentSets.union(leftEndpoint.componentIndex, rightEndpoint.componentIndex);
          if (distance > 0) nearlyConnectedEndpointPairs += 1;
        }
      }
    }
  }

  const endpointClusters = new Map<number, EndpointOccurrence[]>();
  for (let index = 0; index < endpointOccurrences.length; index += 1) {
    const root = endpointSets.find(index);
    const cluster = endpointClusters.get(root) ?? [];
    cluster.push(endpointOccurrences[index]);
    endpointClusters.set(root, cluster);
  }

  const clusterInteriorComponents = new Map<number, Set<number>>();
  for (const [root, cluster] of endpointClusters) {
    const interiorComponents = new Set<number>();
    const representative = cluster[0].coordinate;
    components.forEach((component, componentIndex) => {
      for (let pointIndex = 1; pointIndex < component.length - 1; pointIndex += 1) {
        if (samePoint(representative, component[pointIndex], toleranceMeters)) {
          interiorComponents.add(componentIndex);
          for (const occurrence of cluster) {
            if (occurrence.componentIndex !== componentIndex) {
              componentSets.union(occurrence.componentIndex, componentIndex);
            }
          }
          break;
        }
      }
    });
    clusterInteriorComponents.set(root, interiorComponents);
  }

  const physicalEndpoints = sharedTopology.physicalEndpoints.map((endpoint) => ({
    coordinate: endpoint.coordinate,
    degree: endpoint.degree,
    componentEndpoints: endpoint.componentEndpoints,
  }));

  const endpointDistances: EndpointDistanceDiagnostic[] = [];
  for (let left = 0; left < componentDiagnostics.length; left += 1) {
    for (let right = left + 1; right < componentDiagnostics.length; right += 1) {
      const leftComponent = componentDiagnostics[left];
      const rightComponent = componentDiagnostics[right];
      endpointDistances.push({
        leftComponentIndex: left,
        rightComponentIndex: right,
        startToStartMeters: round(
          calculateCoordinateDistanceMeters(
            leftComponent.startCoordinate,
            rightComponent.startCoordinate,
          ),
          3,
        ),
        startToEndMeters: round(
          calculateCoordinateDistanceMeters(
            leftComponent.startCoordinate,
            rightComponent.endCoordinate,
          ),
          3,
        ),
        endToStartMeters: round(
          calculateCoordinateDistanceMeters(
            leftComponent.endCoordinate,
            rightComponent.startCoordinate,
          ),
          3,
        ),
        endToEndMeters: round(
          calculateCoordinateDistanceMeters(
            leftComponent.endCoordinate,
            rightComponent.endCoordinate,
          ),
          3,
        ),
      });
    }
  }

  const componentGroupCount = sharedTopology.connectedGroupCount;
  const sharedCoordinates = new Map<string, Set<number>>();
  components.forEach((component, componentIndex) => {
    for (const coordinate of component) {
      const indexes = sharedCoordinates.get(coordinateKey(coordinate)) ?? new Set<number>();
      indexes.add(componentIndex);
      sharedCoordinates.set(coordinateKey(coordinate), indexes);
    }
  });
  const sharedCoordinateCount = [...sharedCoordinates.values()].filter(
    (indexes) => indexes.size > 1,
  ).length;
  const segments = new Map<string, Set<number>>();
  components.forEach((component, componentIndex) => {
    for (let index = 1; index < component.length; index += 1) {
      const ends = [
        coordinateKey(component[index - 1]),
        coordinateKey(component[index]),
      ].sort();
      const key = ends.join("|");
      const indexes = segments.get(key) ?? new Set<number>();
      indexes.add(componentIndex);
      segments.set(key, indexes);
    }
  });
  const overlappingSegmentCount = [...segments.values()].filter(
    (indexes) => indexes.size > 1,
  ).length;
  const chain = findComponentChain(components, toleranceMeters);
  const orderedComponentIndexes = chain?.map((value) => value.componentIndex) ?? null;
  const reversedComponentIndexes = chain
    ?.filter((value) => value.reversed)
    .map((value) => value.componentIndex) ?? [];
  const componentsReordered = Boolean(
    chain?.some((value, index) => value.componentIndex !== index),
  );
  const genuinelyDisconnected = sharedTopology.genuinelyDisconnected;
  const ambiguousStartEnd = sharedTopology.ambiguousStartEnd;
  let orderingClassification: ComponentOrderingClassification;
  if (components.length === 1) orderingClassification = "SINGLE_LINESTRING";
  else if (genuinelyDisconnected) orderingClassification = "DISCONNECTED";
  else if (ambiguousStartEnd || !chain) orderingClassification = "AMBIGUOUS_TOPOLOGY";
  else if (componentsReordered && reversedComponentIndexes.length > 0) {
    orderingClassification = "REORDERED_AND_REVERSED_COMPONENTS";
  } else if (componentsReordered) orderingClassification = "REORDERED_COMPONENTS";
  else if (reversedComponentIndexes.length > 0) orderingClassification = "REVERSED_COMPONENT";
  else orderingClassification = "ORDERED";

  const displayedStartCoordinate = componentDiagnostics[0].startCoordinate;
  const displayedEndCoordinate = componentDiagnostics.at(-1)!.endCoordinate;
  const isPhysical = (coordinate: Coordinate) =>
    physicalEndpoints.some((endpoint) =>
      samePoint(endpoint.coordinate, coordinate, toleranceMeters),
    );

  return {
    geometryType: geometry.type,
    componentCount: components.length,
    pointCount: components.reduce((sum, component) => sum + component.length, 0),
    components: componentDiagnostics,
    pairwiseEndpointDistances: endpointDistances,
    displayedStartCoordinate,
    displayedEndCoordinate,
    displayedStartIsPhysicalEndpoint: isPhysical(displayedStartCoordinate),
    displayedEndIsPhysicalEndpoint: isPhysical(displayedEndCoordinate),
    physicalEndpoints,
    physicalEndpointCount: physicalEndpoints.length,
    topologyClassification: sharedTopology.classification,
    connectedGroups: sharedTopology.connectedGroups,
    componentGroupCount,
    genuinelyDisconnected,
    ambiguousStartEnd,
    orderedComponentIndexes,
    reversedComponentIndexes,
    componentsReordered,
    orderingClassification,
    sharedCoordinateCount,
    overlappingSegmentCount,
    overlappingComponents: overlappingSegmentCount > 0,
    nearlyConnectedEndpointPairs,
    topologyEndpointDistanceMeters:
      physicalEndpoints.length === 2 && !genuinelyDisconnected
        ? round(
            calculateCoordinateDistanceMeters(
              physicalEndpoints[0].coordinate,
              physicalEndpoints[1].coordinate,
            ),
          )
        : null,
  };
}

export interface StartEndDiagnosticRouteInput {
  stagingRouteId: string;
  sourceRelationId: string;
  canonicalSourceId: string;
  routeName: string | null;
  semanticType: string;
  qualityScore: number;
  distanceMeters: number;
  geometry: RouteGeometry;
  warnings: string[];
  summit: {
    peakOsmId: string;
    name: string | null;
    coordinate: Coordinate;
  };
  mountain: {
    id: number;
    name: string | null;
    coordinate: Coordinate;
  };
  payloadHashMatchesManifest: boolean;
  geometryMatchesLocalPlan: boolean;
  geometryMatchesReconstruction: boolean;
  orderingEvidence?: {
    relationMemberWayIds: number[];
    relationMemberRoles: string[];
    ways: Array<{
      wayId: number;
      pointCount: number;
      startNodeId: number;
      startCoordinate: Coordinate;
      endNodeId: number;
      endCoordinate: Coordinate;
    }>;
    reconstructionDisconnectedFlag: boolean;
    relationMemberOrderPreserved: boolean;
    orderingChangedAfterReconstruction: boolean;
  };
}

export interface StartEndDiagnosticArtifact {
  schemaVersion: 1;
  diagnosticOnly: true;
  endpointToleranceMeters: number;
  manifestDatasetFingerprint: string;
  manifestRecordCount: number;
  databaseWrites: 0;
  summary: {
    displayedStartNotPhysicalEndpoint: number;
    displayedEndNotPhysicalEndpoint: number;
    routesWithReorderedComponents: number;
    routesWithReversedComponents: number;
    routesWithMoreThanTwoPhysicalEndpoints: number;
    genuinelyDisconnectedGeometry: number;
    ambiguousStartEndSemantics: number;
    overlappingComponents: number;
    classifications: Record<ComponentOrderingClassification, number>;
  };
  routes: Array<Omit<StartEndDiagnosticRouteInput, "geometry"> & StartEndTopologyDiagnostic & {
    currentStraightLineDistanceMeters: number;
    currentRouteToStraightLineRatio: number | null;
    topologyAwareRouteToStraightLineRatio: number | null;
    topologyEndpointSelection: RouteEndpointSelection;
    summitToMountainDistanceMeters: number;
  }>;
}

export function buildStartEndDiagnosticArtifact(input: {
  manifestDatasetFingerprint: string;
  manifestRecordCount: number;
  routes: StartEndDiagnosticRouteInput[];
}): StartEndDiagnosticArtifact {
  const routes = [...input.routes]
    .sort((left, right) => Number(left.sourceRelationId) - Number(right.sourceRelationId))
    .map((route) => {
      const { geometry, ...boundedRoute } = route;
      const topology = analyzeStartEndTopology(geometry);
      const sharedTopology = analyzeRouteTopology(geometry);
      const topologyEndpointSelection = selectRouteEndpoints(sharedTopology, [
        route.summit.coordinate,
      ]);
      const rawCurrentStraightLineDistanceMeters = calculateCoordinateDistanceMeters(
        topology.displayedStartCoordinate,
        route.summit.coordinate,
      );
      const currentStraightLineDistanceMeters = round(rawCurrentStraightLineDistanceMeters);
      return {
        ...boundedRoute,
        ...topology,
        currentStraightLineDistanceMeters,
        currentRouteToStraightLineRatio:
          rawCurrentStraightLineDistanceMeters < 1
            ? null
            : round(route.distanceMeters / rawCurrentStraightLineDistanceMeters, 2),
        topologyAwareRouteToStraightLineRatio:
          topology.topologyEndpointDistanceMeters === null ||
          topology.topologyEndpointDistanceMeters < 1
            ? null
            : round(route.distanceMeters / topology.topologyEndpointDistanceMeters, 2),
        topologyEndpointSelection,
        summitToMountainDistanceMeters: round(
          calculateCoordinateDistanceMeters(
            route.summit.coordinate,
            route.mountain.coordinate,
          ),
        ),
      };
    });
  const classifications = Object.fromEntries(
    [
      "SINGLE_LINESTRING",
      "ORDERED",
      "REVERSED_COMPONENT",
      "REORDERED_COMPONENTS",
      "REORDERED_AND_REVERSED_COMPONENTS",
      "DISCONNECTED",
      "AMBIGUOUS_TOPOLOGY",
    ].map((classification) => [
      classification,
      routes.filter((route) => route.orderingClassification === classification).length,
    ]),
  ) as Record<ComponentOrderingClassification, number>;

  return {
    schemaVersion: 1,
    diagnosticOnly: true,
    endpointToleranceMeters: ENDPOINT_TOLERANCE_METERS,
    manifestDatasetFingerprint: input.manifestDatasetFingerprint,
    manifestRecordCount: input.manifestRecordCount,
    databaseWrites: 0,
    summary: {
      displayedStartNotPhysicalEndpoint: routes.filter(
        (route) => !route.displayedStartIsPhysicalEndpoint,
      ).length,
      displayedEndNotPhysicalEndpoint: routes.filter(
        (route) => !route.displayedEndIsPhysicalEndpoint,
      ).length,
      routesWithReorderedComponents: routes.filter((route) => route.componentsReordered)
        .length,
      routesWithReversedComponents: routes.filter(
        (route) => route.reversedComponentIndexes.length > 0,
      ).length,
      routesWithMoreThanTwoPhysicalEndpoints: routes.filter(
        (route) => route.physicalEndpointCount > 2,
      ).length,
      genuinelyDisconnectedGeometry: routes.filter((route) => route.genuinelyDisconnected)
        .length,
      ambiguousStartEndSemantics: routes.filter((route) => route.ambiguousStartEnd)
        .length,
      overlappingComponents: routes.filter((route) => route.overlappingComponents).length,
      classifications,
    },
    routes,
  };
}
