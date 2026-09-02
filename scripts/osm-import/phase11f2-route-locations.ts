import { runOsmium } from "./osmium-runner.ts";
import { parseOplLine } from "./opl-parser.ts";

const LOCATED_PBF = "data/osm/alps/checkpoints/fafc4f7a772832f2/selected-routes-locations.osm.pbf";

export interface LocatedNode {
  id: number;
  coordinate: [number, number];
  tags: Record<string, string>;
  ele: number | null;
}

export interface LocatedWay {
  id: number;
  tags: Record<string, string>;
  nodes: Array<{ nodeId: number; coordinate: [number, number] | null }>;
}

export async function loadLocatedRoutePbf(): Promise<{
  nodes: Map<number, LocatedNode>;
  ways: Map<number, LocatedWay>;
}> {
  const nodes = new Map<number, LocatedNode>();
  const ways = new Map<number, LocatedWay>();
  await runOsmium(
    ["cat", "-f", "opl,add_metadata=false,locations_on_ways=true", LOCATED_PBF],
    (line) => {
      const obj = parseOplLine(line);
      if (obj.type === "node" && obj.coordinate) {
        const ele = obj.tags.ele ? Number.parseFloat(obj.tags.ele) : NaN;
        nodes.set(obj.id, {
          id: obj.id,
          coordinate: obj.coordinate,
          tags: obj.tags,
          ele: Number.isFinite(ele) ? ele : null,
        });
      } else if (obj.type === "way") {
        ways.set(obj.id, {
          id: obj.id,
          tags: obj.tags,
          nodes: obj.nodes,
        });
      }
    },
  );
  return { nodes, ways };
}
