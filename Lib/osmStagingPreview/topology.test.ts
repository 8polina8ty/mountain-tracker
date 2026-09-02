import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeRouteTopology,
  ROUTE_TOPOLOGY_TOLERANCE_METERS,
  selectRouteEndpoints,
  SUMMIT_ENDPOINT_ORIENTATION_TOLERANCE_METERS,
  type TopologyRouteGeometry,
} from "./topology.ts";

test("topology matching uses the explicit one-meter geographic tolerance", () => {
  const withinTolerance: TopologyRouteGeometry = {
    type: "MultiLineString",
    coordinates: [
      [[10, 46], [10.01, 46]],
      [[10.01, 46.000004], [10.02, 46]],
    ],
  };
  const outsideTolerance: TopologyRouteGeometry = {
    type: "MultiLineString",
    coordinates: [
      [[10, 46], [10.01, 46]],
      [[10.01, 46.00002], [10.02, 46]],
    ],
  };
  assert.equal(ROUTE_TOPOLOGY_TOLERANCE_METERS, 1);
  assert.equal(analyzeRouteTopology(withinTolerance).connectedGroupCount, 1);
  assert.equal(analyzeRouteTopology(outsideTolerance).connectedGroupCount, 2);
});

test("two connected components expose exactly two physical endpoints", () => {
  const topology = analyzeRouteTopology({
    type: "MultiLineString",
    coordinates: [
      [[10, 46], [10.01, 46]],
      [[10.01, 46], [10.02, 46]],
    ],
  });
  assert.equal(topology.classification, "CONNECTED_TWO_ENDPOINTS");
  assert.equal(topology.physicalEndpointCount, 2);
  assert.deepEqual(topology.connectedGroups, [[0, 1]]);
});

test("summit proximity orients the matching physical endpoint as End", () => {
  const topology = analyzeRouteTopology({
    type: "LineString",
    coordinates: [[10, 46], [10.02, 46]],
  });
  const selection = selectRouteEndpoints(topology, [[10.02001, 46]]);
  assert.equal(SUMMIT_ENDPOINT_ORIENTATION_TOLERANCE_METERS, 10);
  assert.equal(selection.orientationReason, "CONFIRMED_SUMMIT_ENDPOINT");
  assert.deepEqual(selection.startCoordinate, [10, 46]);
  assert.deepEqual(selection.endCoordinate, [10.02, 46]);
});

test("orientation without a summit is deterministic and makes no direction claim", () => {
  const geometry: TopologyRouteGeometry = {
    type: "LineString",
    coordinates: [[10.02, 46], [10, 46]],
  };
  const first = selectRouteEndpoints(analyzeRouteTopology(geometry));
  const second = selectRouteEndpoints(analyzeRouteTopology(geometry));
  assert.deepEqual(first, second);
  assert.equal(first.orientationReason, "DETERMINISTIC_COMPONENT_ENDPOINT_ORDER");
  assert.deepEqual(first.startCoordinate, [10.02, 46]);
});

test("branching topology infers an ambiguous pair from physical endpoints", () => {
  const geometry: TopologyRouteGeometry = {
    type: "MultiLineString",
    coordinates: [
      [[10, 46], [10.01, 46]],
      [[10.01, 46], [10.02, 46]],
      [[10.01, 46], [10.01, 46.01]],
    ],
  };
  const topology = analyzeRouteTopology(geometry);
  const selection = selectRouteEndpoints(topology, [[10.02, 46]]);
  assert.equal(topology.classification, "BRANCHING");
  assert.equal(topology.physicalEndpointCount, 3);
  assert.equal(selection.available, true);
  assert.deepEqual(selection.startCoordinate, [10, 46]);
  assert.deepEqual(selection.endCoordinate, [10.02, 46]);
  assert.equal(selection.orientationReason, "INFERRED_BRANCHING_PHYSICAL_ENDPOINTS");
  assert.equal(selection.ambiguous, true);
  assert.equal(selection.warning, "BRANCHING_ENDPOINT_SELECTION_AMBIGUOUS");
});

test("branching topology without two physical endpoints remains unavailable", () => {
  const topology = analyzeRouteTopology({
    type: "MultiLineString",
    coordinates: [
      [[10, 46], [10.01, 46], [10, 46]],
      [[10, 46], [10, 46.01]],
    ],
  });
  const selection = selectRouteEndpoints(topology);
  assert.equal(topology.classification, "BRANCHING");
  assert.equal(topology.physicalEndpointCount, 1);
  assert.equal(selection.available, false);
  assert.equal(selection.startCoordinate, null);
  assert.equal(selection.endCoordinate, null);
});

test("disconnected topology preserves separate groups and hides global endpoints", () => {
  const geometry: TopologyRouteGeometry = {
    type: "MultiLineString",
    coordinates: [
      [[10, 46], [10.01, 46]],
      [[11, 46], [11.01, 46]],
    ],
  };
  const topology = analyzeRouteTopology(geometry);
  assert.equal(topology.classification, "DISCONNECTED");
  assert.deepEqual(topology.connectedGroups, [[0], [1]]);
  const selection = selectRouteEndpoints(topology);
  assert.equal(selection.available, false);
  assert.equal(selection.startCoordinate, null);
  assert.equal(selection.endCoordinate, null);
  assert.equal(selection.warning, "DISCONNECTED_GLOBAL_ENDPOINTS_UNAVAILABLE");
});

test("closed geometry reports ambiguous endpoint semantics", () => {
  const topology = analyzeRouteTopology({
    type: "LineString",
    coordinates: [[10, 46], [10.01, 46], [10, 46]],
  });
  assert.equal(topology.classification, "AMBIGUOUS");
  assert.equal(topology.physicalEndpointCount, 0);
  assert.equal(selectRouteEndpoints(topology).available, false);
});

test("topology analysis is deterministic and never mutates stored geometry", () => {
  const geometry: TopologyRouteGeometry = {
    type: "MultiLineString",
    coordinates: [
      [[10.01, 46], [10, 46]],
      [[10.01, 46], [10.02, 46]],
    ],
  };
  const before = JSON.stringify(geometry);
  const first = analyzeRouteTopology(geometry);
  const second = analyzeRouteTopology(geometry);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(geometry), before);
});
