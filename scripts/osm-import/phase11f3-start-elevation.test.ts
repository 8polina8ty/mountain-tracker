import assert from "node:assert/strict";
import test from "node:test";

import { classifyStartContextV3, type FeatureIndex } from "./start-context-classifier3.ts";
import {
  resolveStartElevationV3,
  buildFeatureIndex,
  type Phase11f3FeatureIndex,
} from "./phase11f3-start-elevation.ts";
import { normalizeEle } from "./ele-normalizer.ts";

type Coord = [number, number];

function emptyFeatureIndex(): FeatureIndex {
  return {
    alpineHuts: [],
    wildernessHuts: [],
    mountainPasses: [],
    saddles: [],
    ridges: [],
    peaks: [],
    trailheads: [],
    trailheadInfo: [],
    parking: [],
    villages: [],
    hamlets: [],
    isolatedDwellings: [],
    farms: [],
    busStops: [],
    trainStations: [],
    halts: [],
    eleNodes: [],
  };
}

interface EleF {
  osmid: string;
  c: Coord;
  raw: string;
}
interface FeatF {
  type:
    | "parking"
    | "trailhead"
    | "trailhead_info"
    | "bus_stop"
    | "halt"
    | "village"
    | "hamlet"
    | "isolated_dwelling"
    | "farm"
    | "alpine_hut"
    | "saddle"
    | "peak";
  osmid: string;
  c: Coord;
  ele?: string;
  name?: string | null;
}

function build(source: FeatureIndex, eleNodes: EleF[]): Phase11f3FeatureIndex {
  const mapped = eleNodes.map((n) => {
    const parsed = normalizeEle(n.raw);
    return {
      osmid: n.osmid,
      coordinate: n.c,
      rawEle: n.raw,
      parseStatus: parsed.status,
      normalizedMeters: parsed.normalizedMeters,
      name: null,
    };
  });
  return buildFeatureIndex(source, mapped);
}

function buildIndex(feats: FeatF[], eleNodes: EleF[]): { feat: FeatureIndex; f3: Phase11f3FeatureIndex } {
  const feat = emptyFeatureIndex();
  const f2Record = (
    t: NonNullable<FeatF["type"]>,
    osmid: string,
    c: Coord,
    ele?: string,
    name: string | null = null,
  ): { objectType: "node"; osmid: string; name: string | null; coordinate: Coord; wayNodeCount: null; tags: Record<string, string> } => ({
    objectType: "node" as const,
    osmid,
    name,
    coordinate: c,
    wayNodeCount: null,
    tags: (ele !== undefined ? { ele } : {}) as Record<string, string>,
  });
  for (const f of feats) {
    const rec = f2Record(f.type, f.osmid, f.c, f.ele, f.name ?? null);
    switch (f.type) {
      case "parking": feat.parking.push(rec); break;
      case "trailhead": feat.trailheads.push(rec); break;
      case "trailhead_info": feat.trailheadInfo.push(rec); break;
      case "bus_stop": feat.busStops.push(rec); break;
      case "halt": feat.halts.push(rec); break;
      case "village": feat.villages.push(rec); break;
      case "hamlet": feat.hamlets.push(rec); break;
      case "isolated_dwelling": feat.isolatedDwellings.push(rec); break;
      case "farm": feat.farms.push(rec); break;
      case "alpine_hut": feat.alpineHuts.push(rec); break;
      case "saddle": feat.saddles.push(rec); break;
      case "peak": feat.peaks.push(rec); break;
    }
  }
  return { feat, f3: build(feat, eleNodes) };
}

async function classify(
  start: Coord,
  summit: number,
  feats: FeatF[],
  eleNodes: EleF[],
): Promise<ReturnType<typeof classifyStartContextV3> extends Promise<infer T> ? T : never> {
  const { feat, f3 } = buildIndex(feats, eleNodes);
  return classifyStartContextV3(start, start, summit, feat, f3);
}

test("exact endpoint ele node is the highest-priority deterministic source", () => {
  const { f3 } = buildIndex([], [{ osmid: "e1", c: [10, 45], raw: "1200" }]);
  const res = resolveStartElevationV3([10.001, 45.001], f3);
  assert.equal(res.deterministic, true);
  assert.equal(res.selectedSource?.sourceType, "EXACT_ENDPOINT_OSM_ELE");
  assert.equal(res.startElevationMeters, 1200);
  assert.ok(res.candidates.some((c) => c.sourceType === "EXACT_ENDPOINT_OSM_ELE"));
});

test("exact trailhead/hut/parking feature ele is deterministic", () => {
  const { f3 } = buildIndex(
    [{ type: "parking", osmid: "p1", c: [10.001, 45.001], ele: "970", name: "P1" }],
    [],
  );
  const res = resolveStartElevationV3([10.0, 45.0], f3);
  assert.equal(res.deterministic, true);
  assert.equal(res.selectedSource?.sourceType, "EXACT_START_FEATURE_ELE");
  assert.equal(res.startElevationMeters, 970);
});

test("arbitrary nearby ele node beyond radius is rejected", () => {
  const { f3 } = buildIndex([], [{ osmid: "e1", c: [10.005, 45.01], raw: "1500" }]);
  const res = resolveStartElevationV3([10.0, 45.0], f3);
  assert.equal(res.deterministic, false);
  assert.equal(res.selectedSource, null);
  assert.equal(res.reasonCodes.includes("START_ELEVATION_UNPROVEN"), true);
});

test("distant dwelling ele is not accepted as start elevation", () => {
  const { f3 } = buildIndex(
    [{ type: "isolated_dwelling", osmid: "d1", c: [10.01, 45.01], ele: "900" }],
    [],
  );
  const res = resolveStartElevationV3([10.0, 45.0], f3);
  assert.equal(res.deterministic, false);
});

test("malformed ele is rejected and never used", () => {
  const { f3 } = buildIndex([], [{ osmid: "e1", c: [10.0001, 45.0001], raw: "abc" }]);
  const res = resolveStartElevationV3([10.0, 45.0], f3);
  assert.equal(res.deterministic, false);
});

test("feet ele is intentionally converted to meters", () => {
  assert.equal(normalizeEle("4000 ft").status, "VALID_CONVERTED_FEET");
  const { f3 } = buildIndex([], [{ osmid: "e1", c: [10.0001, 45.0001], raw: "4000 ft" }]);
  const res = resolveStartElevationV3([10.0, 45.0], f3);
  assert.equal(res.deterministic, true);
  assert.equal(res.selectedSource?.parseStatus, "VALID_CONVERTED_FEET");
  assert.equal((res.startElevationMeters as number) > 1200 && (res.startElevationMeters as number) < 1220, true);
});

test("conflicting same-type elevation sources fail closed", () => {
  const { f3 } = buildIndex([], [
    { osmid: "e1", c: [10.0001, 45.0001], raw: "1200" },
    { osmid: "e2", c: [10.0002, 45.0001], raw: "900" },
  ]);
  const res = resolveStartElevationV3([10.0, 45.0], f3);
  assert.equal(res.deterministic, false);
  assert.equal(res.conflict, true);
  assert.equal(res.reasonCodes.includes("START_ELEVATION_CONFLICT"), true);
});

test("BASE with gain >= 500 is GREEN-compatible", async () => {
  const ctx = await classify(
    [10.0, 45.0],
    2000,
    [{ type: "parking", osmid: "p1", c: [10.001, 45.001], ele: "1200" }],
    [],
  );
  assert.equal(ctx.type, "BASE_START");
  assert.equal(ctx.startElevationSource, "EXACT_START_FEATURE_ELE");
  assert.equal(ctx.startElevationMeters, 1200);
  assert.equal(ctx.verticalGainMeters, 800);
});

test("HUT short ascent remains GREEN-compatible (no 500 requirement)", async () => {
  const ctx = await classify(
    [10.0, 45.0],
    1600,
    [{ type: "alpine_hut", osmid: "h1", c: [10.001, 45.001], name: "Hut" }],
    [{ osmid: "e1", c: [10.0005, 45.0005], raw: "1400" }],
  );
  assert.equal(ctx.type, "HUT_START");
});

test("negative/zero ascent is never GREEN", async () => {
  const ctx = await classify(
    [10.0, 45.0],
    1200,
    [{ type: "parking", osmid: "p1", c: [10.001, 45.001], ele: "1200" }],
    [],
  );
  assert.equal(ctx.type, "AMBIGUOUS_START");
  assert.ok(ctx.reasons.some((r) => r.includes("START_ELEVATION_INVALID")));
});

test("Tothorn starts at a saddle and remains HIGH (not GREEN)", async () => {
  const ctx = await classify(
    [10.0, 45.0],
    2837,
    [
      { type: "saddle", osmid: "s1", c: [10.001, 45.001], name: "Rezlipass" },
      { type: "parking", osmid: "p1", c: [10.003, 45.003], ele: "1200" },
    ],
    [{ osmid: "e1", c: [10.0005, 45.0005], raw: "2837" }],
  );
  assert.equal(ctx.type, "HIGH_MOUNTAIN_START");
});

test("6779777 does not pick up a distant isolated dwelling ele", async () => {
  const ctx = await classify(
    [10.0, 45.0],
    1800,
    [{ type: "isolated_dwelling", osmid: "d1", c: [10.001, 45.0008], ele: "400" }],
    [],
  );
  assert.equal(ctx.type, "AMBIGUOUS_START");
  assert.equal(ctx.startElevationMeters, null);
});
