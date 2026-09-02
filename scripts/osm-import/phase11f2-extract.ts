import { mkdir } from "node:fs/promises";
import { runOsmium } from "./osmium-runner.ts";
import { parseOplLine, type OplWay, type OplNode } from "./opl-parser.ts";

export interface ExtractFeatureRecord {
  objectType: "node" | "way" | "relation";
  osmid: string;
  name: string | null;
  tags: Record<string, string>;
  coordinate: [number, number] | null;
  boundary: [number, number][] | null;
  centroid: [number, number] | null;
  wayNodeCount: number | null;
}

function polygonCentroid(ring: [number, number][]): [number, number] | null {
  if (ring.length < 3) return null;
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const f = xi * yj - xj * yi;
    area += f;
    cx += (xi + xj) * f;
    cy += (yi + yj) * f;
  }
  if (area === 0) return null;
  area *= 0.5;
  return [cx / (6 * area), cy / (6 * area)];
}

export async function extractFeatures(
  pbfPath: string,
  tagFilters: string[],
  workPrefix: string,
): Promise<ExtractFeatureRecord[]> {
  const workDir = "data/osm/alps/staging/phase11f2-work";
  await mkdir(workDir, { recursive: true });
  const rawPbf = `${workDir}/${workPrefix}.pbf`;
  const locatedPbf = `${workDir}/${workPrefix}-located.pbf`;

  // Filter: nodes + ways (+ relations via tag filter where relevant)
  const filters: string[] = [];
  for (const f of tagFilters) {
    if (f.startsWith("n/")) filters.push(`w/${f.slice(2)}`);
    else filters.push(f);
    filters.push(f);
  }
  await runOsmium([
    "tags-filter",
    "--overwrite",
    "-o",
    rawPbf,
    pbfPath,
    ...filters,
  ]);
  await runOsmium([
    "add-locations-to-ways",
    "-f",
    "pbf,locations_on_ways=true,add_metadata=false",
    "-o",
    locatedPbf,
    rawPbf,
  ]);

  const nodes = new Map<number, OplNode>();
  const ways: OplWay[] = [];
  await runOsmium(
    ["cat", "-f", "opl,add_metadata=false,locations_on_ways=true", locatedPbf],
    (line) => {
      const obj = parseOplLine(line);
      if (obj.type === "node" && obj.coordinate) {
        nodes.set(obj.id, obj);
      } else if (obj.type === "way") {
        ways.push(obj);
      }
    },
  );

  const records: ExtractFeatureRecord[] = [];
  // Ways first (areas)
  for (const way of ways) {
    const ring: [number, number][] = [];
    let ok = true;
    for (const n of way.nodes) {
      if (n.coordinate) ring.push(n.coordinate);
      else {
        const resolved = nodes.get(n.nodeId);
        if (resolved?.coordinate) ring.push(resolved.coordinate);
        else {
          ok = false;
          break;
        }
      }
    }
    if (!ok) continue;
    const centroid = polygonCentroid(ring);
    records.push({
      objectType: "way",
      osmid: String(way.id),
      name: way.tags.name ?? null,
      tags: way.tags,
      coordinate: centroid,
      boundary: ring,
      centroid,
      wayNodeCount: ring.length,
    });
  }
  // Then nodes
  for (const node of nodes.values()) {
    records.push({
      objectType: "node",
      osmid: String(node.id),
      name: node.tags.name ?? null,
      tags: node.tags,
      coordinate: node.coordinate,
      boundary: null,
      centroid: null,
      wayNodeCount: null,
    });
  }
  return records;
}
