import assert from "node:assert/strict";
import test from "node:test";

import { compareRoutes } from "../../scripts/osm-import/route-similarity.ts";
import {
  OSM_ANCHOR_RESOLUTION_VERSION,
  type OsmAnchorResolution,
  type ResolvedOsmAnchor,
} from "./osmAnchorResolution.ts";
import {
  buildOsmTrailGraph,
  evaluateHikingCost,
  type OsmTrailGraph,
  type OsmTrailWayInput,
} from "./osmTrailGraph.ts";
import {
  reconstructOsmRoute,
  solveGraphPathAStar,
  toPhase11ComparableRoute,
} from "./osmRouteReconstruction.ts";
import { createRouteDiscoverySignal, type SemanticAnchorType } from "./routeDiscovery.ts";
import type { Coordinate } from "./types.ts";

const EARTH_RADIUS_METERS = 6_371_008.8;
const LATITUDE = 47;

function coordinate(eastM: number, northM = 0): Coordinate {
  return [
    11 +
      (eastM / (EARTH_RADIUS_METERS * Math.cos((LATITUDE * Math.PI) / 180))) *
        (180 / Math.PI),
    LATITUDE + (northM / EARTH_RADIUS_METERS) * (180 / Math.PI),
  ];
}

function node(nodeId: number, eastM: number, northM = 0) {
  return { nodeId, coordinate: coordinate(eastM, northM) };
}

function way(
  id: number,
  nodes: ReturnType<typeof node>[],
  tags: Record<string, string> = { highway: "path" },
): OsmTrailWayInput {
  return { id, nodes, tags };
}

const dataset = {
  datasetKey: "synthetic-alps-test",
  region: "synthetic",
  snapshotTimestamp: "2026-09-04T00:00:00.000Z",
  pbfSha256: "a".repeat(64),
};

function lineGraph(): OsmTrailGraph {
  return buildOsmTrailGraph(dataset, [
    way(10, [node(1, 0), node(2, 100), node(3, 200), node(4, 300)]),
  ]);
}

function resolution(
  name: string,
  anchorType: SemanticAnchorType,
  osmId: number,
  point: Coordinate,
): OsmAnchorResolution {
  const anchor: ResolvedOsmAnchor = {
    resolutionVersion: OSM_ANCHOR_RESOLUTION_VERSION,
    anchorType,
    osmObjectType: "node",
    osmId,
    name,
    coordinate: point,
    tagsSubset: { name },
    resolutionConfidence: 0.95,
    resolutionEvidence: ["EXACT_OSM_NAME"],
    geometrySource: "OPENSTREETMAP",
  };
  return { status: "RESOLVED", anchor, candidates: [anchor] };
}

function signal(input: {
  shape?: "ONE_WAY" | "OUT_AND_BACK" | "LOOP" | "TRAVERSE" | "UNKNOWN";
  vias?: string[];
  terminal?: string | null;
  reverse?: boolean;
} = {}) {
  const reverse = input.reverse ?? false;
  return createRouteDiscoverySignal({
    signalId: reverse ? "manual:reverse" : `manual:${(input.shape ?? "one_way").toLowerCase()}`,
    sourceKey: "manual-research",
    sourceReference: "phase12c:synthetic",
    observedAt: "2026-09-04T00:00:00.000Z",
    mountainIdentity: { name: reverse ? "Start" : "Summit", regionName: null, countryCode: null },
    routeVariantName: "A creative source title that must not become a public title",
    activityType: "HIKING",
    startHint: { name: reverse ? "Summit" : "Start", expectedTypes: [reverse ? "SUMMIT" : "TRAILHEAD"], regionName: null },
    viaHints: (input.vias ?? []).map((name) => ({ name, expectedTypes: ["HUT"], regionName: null })),
    summitHint: { name: reverse ? "Start" : "Summit", expectedTypes: [reverse ? "TRAILHEAD" : "SUMMIT"], regionName: null },
    terminalHint: input.terminal
      ? { name: input.terminal, expectedTypes: ["TRAILHEAD"], regionName: null }
      : null,
    routeShapeHint: input.shape ?? "ONE_WAY",
    directionHint: reverse ? "descent" : "ascent",
    sourcePolicyStatus: "ALLOWED",
    signalConfidence: 0.9,
  });
}

test("graph construction hard-blocks motorway, private, and foot=no ways", () => {
  const graph = buildOsmTrailGraph(dataset, [
    way(1, [node(1, 0), node(2, 10)], { highway: "motorway" }),
    way(2, [node(3, 0), node(4, 10)], { highway: "motorway_link" }),
    way(3, [node(5, 0), node(6, 10)], { highway: "path", access: "private" }),
    way(4, [node(7, 0), node(8, 10)], { highway: "path", foot: "no" }),
    way(6, [node(11, 0), node(12, 10)], { highway: "track", smoothness: "impassable" }),
    way(5, [node(9, 0), node(10, 10)], {
      highway: "path",
      access: "private",
      foot: "permissive",
    }),
  ]);
  assert.deepEqual(graph.exclusions, [
    { wayId: 1, reason: "MOTORWAY" },
    { wayId: 2, reason: "MOTORWAY_LINK" },
    { wayId: 3, reason: "ACCESS_FORBIDDEN" },
    { wayId: 4, reason: "FOOT_FORBIDDEN" },
    { wayId: 6, reason: "IMPASSABLE" },
  ]);
  assert.equal(graph.edges.length, 2);
});

test("path, footway, steps, and track form graph edges with bounded soft costs", () => {
  const graph = buildOsmTrailGraph(dataset, [
    way(1, [node(1, 0), node(2, 10)], { highway: "path", sac_scale: "alpine_hiking" }),
    way(2, [node(2, 10), node(3, 20)], { highway: "footway" }),
    way(3, [node(3, 20), node(4, 30)], { highway: "steps" }),
    way(4, [node(4, 30), node(5, 40)], { highway: "track", surface: "gravel" }),
  ]);
  assert.equal(new Set(graph.edges.map((edge) => edge.wayId)).size, 4);
  assert.ok(evaluateHikingCost({ highway: "path", sac_scale: "difficult_alpine_hiking" }).multiplier < 1.25);
  assert.ok(evaluateHikingCost({ highway: "steps" }).multiplier > 1);
});

test("A* deterministically chooses the plausible path over an equal-length track", () => {
  const graph = buildOsmTrailGraph(dataset, [
    way(10, [node(1, 0), node(2, 100, 20), node(4, 200)]),
    way(11, [node(1, 0), node(3, 100, -20), node(4, 200)], { highway: "track" }),
  ]);
  const first = solveGraphPathAStar(graph, 1, 4);
  const second = solveGraphPathAStar(graph, 1, 4);
  assert.deepEqual(first, second);
  assert.deepEqual(first?.nodeIds, [1, 2, 4]);
  assert.deepEqual(first?.edges.map((edge) => edge.wayId), [10, 10]);
});

test("reconstruction honors via-anchor ordering and retains OSM provenance", () => {
  const graph = lineGraph();
  const result = reconstructOsmRoute({
    signal: signal({ vias: ["Hut", "Pass"] }),
    anchors: {
      start: resolution("Start", "TRAILHEAD", 101, coordinate(0)),
      vias: [
        resolution("Hut", "HUT", 102, coordinate(100)),
        resolution("Pass", "HUT", 103, coordinate(200)),
      ],
      summit: resolution("Summit", "SUMMIT", 104, coordinate(300)),
    },
    graph,
    startContext: "BASE_START",
  });
  assert.equal(result.status, "RECONSTRUCTED");
  if (!result.route) return;
  assert.deepEqual(result.route.osmNodeIds, [1, 2, 3, 4]);
  assert.deepEqual(result.route.resolvedAnchors.map((entry) => entry.role), [
    "START",
    "VIA",
    "VIA",
    "SUMMIT",
  ]);
  assert.deepEqual(result.route.osmWayIds, [10]);
  assert.equal(result.route.geometryProvenance.sourceKey, "openstreetmap");
  assert.equal(result.route.geometryProvenance.license, "ODbL-1.0");
  assert.equal(result.route.discoveryProvenance.sourceKey, "manual-research");
  assert.equal("routeVariantName" in result.route, false);
});

test("ambiguous or missing anchors fail closed before graph routing", () => {
  const graph = lineGraph();
  for (const bad of [
    { status: "AMBIGUOUS", anchor: null, candidates: [] },
    { status: "NOT_FOUND", anchor: null, candidates: [] },
  ] as OsmAnchorResolution[]) {
    const result = reconstructOsmRoute({
      signal: signal(),
      anchors: {
        start: bad,
        vias: [],
        summit: resolution("Summit", "SUMMIT", 104, coordinate(300)),
      },
      graph,
      startContext: "BASE_START",
    });
    assert.equal(result.status, "ANCHOR_UNRESOLVED");
  }
});

test("disconnected graph returns NO_ROUTE and never fabricates a gap", () => {
  const graph = buildOsmTrailGraph(dataset, [
    way(1, [node(1, 0), node(2, 50)]),
    way(2, [node(3, 300), node(4, 350)]),
  ]);
  const result = reconstructOsmRoute({
    signal: signal(),
    anchors: {
      start: resolution("Start", "TRAILHEAD", 101, coordinate(0)),
      vias: [],
      summit: resolution("Summit", "SUMMIT", 104, coordinate(350)),
    },
    graph,
    startContext: "BASE_START",
  });
  assert.deepEqual(result, {
    status: "NO_ROUTE",
    route: null,
    reasons: ["NO_SAFE_GRAPH_PATH_START_TO_SUMMIT"],
  });
});

test("anchor snapping is bounded and does not insert straight-line geometry", () => {
  const graph = lineGraph();
  const result = reconstructOsmRoute({
    signal: signal(),
    anchors: {
      start: resolution("Start", "TRAILHEAD", 101, coordinate(-100)),
      vias: [],
      summit: resolution("Summit", "SUMMIT", 104, coordinate(300)),
    },
    graph,
    startContext: "BASE_START",
  });
  assert.equal(result.status, "NO_ROUTE");
  assert.deepEqual(result.reasons, ["START_OUTSIDE_SNAP_THRESHOLD"]);
});

test("OUT_AND_BACK stores ascent once and represents return semantically", () => {
  const result = reconstructOsmRoute({
    signal: signal({ shape: "OUT_AND_BACK" }),
    anchors: {
      start: resolution("Start", "TRAILHEAD", 101, coordinate(0)),
      vias: [],
      summit: resolution("Summit", "SUMMIT", 104, coordinate(300)),
    },
    graph: lineGraph(),
    startContext: "BASE_START",
  });
  assert.equal(result.route?.returnSemantics, "SAME_PATH_REVERSE");
  assert.deepEqual(result.route?.osmNodeIds, [1, 2, 3, 4]);
});

test("LOOP returns to its start while TRAVERSE preserves a distinct terminal", () => {
  const graph = lineGraph();
  const loop = reconstructOsmRoute({
    signal: signal({ shape: "LOOP" }),
    anchors: {
      start: resolution("Start", "TRAILHEAD", 101, coordinate(0)),
      vias: [],
      summit: resolution("Summit", "SUMMIT", 104, coordinate(300)),
    },
    graph,
    startContext: "BASE_START",
  });
  assert.equal(loop.route?.returnSemantics, "CLOSED_LOOP");
  assert.equal(loop.route?.osmNodeIds.at(-1), 1);

  const traverse = reconstructOsmRoute({
    signal: signal({ shape: "TRAVERSE", terminal: "Terminal" }),
    anchors: {
      start: resolution("Start", "TRAILHEAD", 101, coordinate(0)),
      vias: [],
      summit: resolution("Summit", "SUMMIT", 103, coordinate(200)),
      terminal: resolution("Terminal", "TRAILHEAD", 104, coordinate(300)),
    },
    graph,
    startContext: "BASE_START",
  });
  assert.equal(traverse.route?.returnSemantics, "TRAVERSE_TERMINAL");
  assert.equal(traverse.route?.osmNodeIds.at(-1), 4);
});

test("high-mountain and ambiguous starts remain fail-closed review results", () => {
  for (const startContext of ["HIGH_MOUNTAIN_START", "AMBIGUOUS_START"] as const) {
    const result = reconstructOsmRoute({
      signal: signal(),
      anchors: {
        start: resolution("Start", "TRAILHEAD", 101, coordinate(0)),
        vias: [],
        summit: resolution("Summit", "SUMMIT", 104, coordinate(300)),
      },
      graph: lineGraph(),
      startContext,
    });
    assert.equal(result.status, "NEEDS_REVIEW");
    assert.ok(result.route?.warnings.includes(startContext));
  }
});

test("graph, route manifest, and geometry hashes are deterministic", () => {
  const ways = [
    way(20, [node(2, 100), node(3, 200)]),
    way(10, [node(1, 0), node(2, 100)]),
    way(30, [node(3, 200), node(4, 300)]),
  ];
  const firstGraph = buildOsmTrailGraph(dataset, ways);
  const secondGraph = buildOsmTrailGraph(dataset, [...ways].reverse());
  assert.equal(firstGraph.graphHash, secondGraph.graphHash);
  const run = (graph: OsmTrailGraph) =>
    reconstructOsmRoute({
      signal: signal(),
      anchors: {
        start: resolution("Start", "TRAILHEAD", 101, coordinate(0)),
        vias: [],
        summit: resolution("Summit", "SUMMIT", 104, coordinate(300)),
      },
      graph,
      startContext: "BASE_START",
    });
  assert.deepEqual(run(firstGraph), run(secondGraph));
});

test("direction-neutral hash is stable when route direction is reversed", () => {
  const graph = lineGraph();
  const forward = reconstructOsmRoute({
    signal: signal(),
    anchors: {
      start: resolution("Start", "TRAILHEAD", 101, coordinate(0)),
      vias: [],
      summit: resolution("Summit", "SUMMIT", 104, coordinate(300)),
    },
    graph,
    startContext: "BASE_START",
  });
  const reverse = reconstructOsmRoute({
    signal: signal({ reverse: true }),
    anchors: {
      start: resolution("Summit", "SUMMIT", 104, coordinate(300)),
      vias: [],
      summit: resolution("Start", "TRAILHEAD", 101, coordinate(0)),
    },
    graph,
    startContext: "BASE_START",
  });
  assert.notEqual(forward.route?.geometryHash, reverse.route?.geometryHash);
  assert.equal(
    forward.route?.directionNeutralGeometryHash,
    reverse.route?.directionNeutralGeometryHash,
  );
});

test("reconstructed output remains compatible with Phase 11 route similarity", () => {
  const result = reconstructOsmRoute({
    signal: signal(),
    anchors: {
      start: resolution("Start", "TRAILHEAD", 101, coordinate(0)),
      vias: [],
      summit: resolution("Summit", "SUMMIT", 104, coordinate(300)),
    },
    graph: lineGraph(),
    startContext: "BASE_START",
  });
  assert.ok(result.route);
  if (!result.route) return;
  const comparable = toPhase11ComparableRoute(result.route, "summit-104");
  assert.equal(compareRoutes(comparable, { ...comparable, sourceId: "osm-truth" }).classification, "EXACT_DUPLICATE");
});
