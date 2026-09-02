import assert from "node:assert/strict";
import test from "node:test";

import type { ClassifiableRoute } from "./route-classifier.ts";
import { classifyRouteActivity } from "./route-activity-classifier.ts";

function route(input: {
  name: string;
  route?: string;
  tags?: Record<string, string>;
}): ClassifiableRoute {
  return {
    sourceId: "1",
    sourceUrl: "https://www.openstreetmap.org/relation/1",
    name: input.name,
    ref: null,
    network: "lwn",
    operator: null,
    geometry: { type: "LineString", coordinates: [[10, 46], [10.1, 46.1]] },
    stats: { distanceMeters: 10_000, coordinatePoints: 2, componentCount: 1 },
    metadata: {
      route: input.route ?? "hiking",
      from: null,
      to: null,
      roundtrip: null,
      osmcSymbol: null,
      tags: input.tags ?? {},
    },
  };
}

test("ordinary hiking stays hiking", () => {
  assert.equal(classifyRouteActivity(route({ name: "Wanderweg 534" })).routeType, "hiking");
});

test("via ferrata can independently retain summit_route role", () => {
  const result = classifyRouteActivity(route({
    name: "Via Ferrata Rosalba Grasselli",
    tags: { cai_scale: "EEA", website: "https://example.test/ferrata" },
  }));
  assert.equal(result.routeType, "via_ferrata");
  assert.equal(result.manualReviewRequired, false);
});

test("mountaineering evidence overrides generic hiking", () => {
  assert.equal(classifyRouteActivity(route({ name: "Alpine route", tags: { sac_scale: "alpine_hiking" } })).routeType, "mountaineering");
});

test("ski touring evidence overrides generic hiking", () => {
  assert.equal(classifyRouteActivity(route({ name: "Winter Skitour", tags: { "piste:type": "skitour" } })).routeType, "ski_touring");
});

test("climbing evidence overrides generic hiking", () => {
  assert.equal(classifyRouteActivity(route({ name: "South ridge climbing route", tags: { sport: "climbing" } })).routeType, "climbing");
});

test("conflicting technical evidence fails closed as mixed", () => {
  const result = classifyRouteActivity(route({ name: "Via ferrata and ski tour" }));
  assert.equal(result.routeType, "mixed");
  assert.equal(result.manualReviewRequired, true);
  assert.deepEqual(result.conflictingTypes, ["ski_touring", "via_ferrata"]);
});

test("insufficient evidence fails closed as other", () => {
  const value = route({ name: "Unclear route", route: "" });
  value.network = null;
  const result = classifyRouteActivity(value);
  assert.equal(result.routeType, "other");
  assert.equal(result.manualReviewRequired, true);
});
